const Season = require('../models/Season');
const User = require('../models/User');
const Department = require('../models/Department');
const { sendEmail } = require('./emailService');
const Setting = require('../models/Setting');
const logActivity = require('./logActivity');
const moment = require('moment');

/**
 * Recalculates the computed start and end dates for all tasks in a snapshot
 * based on their dependencies and actual completion dates.
 * This is an iterative process to handle chains of dependencies.
 * @param {Array} tasks - The array of tasks from the snapshot.
 * @param {Date} seasonCreatedAt - The creation date of the season.
 */
function recalculateAllTaskDates(tasks, seasonCreatedAt) {
  const tasksMap = new Map(tasks.map(t => [t.order, t]));
  let changedInIteration = true;
  let iterationCount = 0;
  const maxIterations = tasks.length + 5; // Failsafe against infinite loops

  while (changedInIteration && iterationCount < maxIterations) {
    changedInIteration = false;
    iterationCount++;

    tasks.forEach(task => {
      // Do not recalculate dates for tasks that are already completed. Their dates are historical facts.
      if (!task || task.actualCompletion) {
        return;
      }

      let allPredecessorsComplete = true;
      let latestPredecessorCompletionDate = null;

      // If a task has no predecessors, its start date is the season creation date.
      if (!task.precedingTasks || task.precedingTasks.length === 0) {
        latestPredecessorCompletionDate = new Date(seasonCreatedAt);
      } else {
        // Find the latest completion date among all predecessors.
        for (const predOrder of task.precedingTasks) {
          const predecessor = tasksMap.get(predOrder);

          // If any predecessor is not found or not complete, we cannot calculate this task's start date.
          if (!predecessor || !predecessor.actualCompletion) {
            allPredecessorsComplete = false;
            break;
          }

          const predCompletionDate = new Date(predecessor.actualCompletion);
          if (!latestPredecessorCompletionDate || predCompletionDate > latestPredecessorCompletionDate) {
            latestPredecessorCompletionDate = predCompletionDate;
          }
        }
      }

      // If all predecessors are complete, we can calculate the start date.
      if (allPredecessorsComplete && latestPredecessorCompletionDate) {
        const newStartDate = new Date(latestPredecessorCompletionDate);
        const oldStart = task.computedDates.start ? new Date(task.computedDates.start).getTime() : null;

        // Only update if the date has changed.
        if (newStartDate.getTime() !== oldStart) {
          task.computedDates.start = newStartDate;
          const newEndDate = new Date(newStartDate);
          newEndDate.setDate(newStartDate.getDate() + task.leadTime);
          task.computedDates.end = newEndDate;
          changedInIteration = true;
        }
      } else {
        // If predecessors are not ready, clear the dates for this task to show it's not scheduled.
        if (task.computedDates.start !== null || task.computedDates.end !== null) {
          task.computedDates.start = null;
          task.computedDates.end = null;
          changedInIteration = true;
        }
      }
    });
  }

  if (iterationCount >= maxIterations) {
    console.error('ERROR: Date calculation exceeded max iterations. Check for circular dependencies.');
  }
}

/**
 * Updates the season's 'requireAttention' field based on the next pending task.
 * @param {Object} season - The Mongoose Season document.
 * @param {Array} tasks - The array of tasks from the snapshot.
 */
async function updateSeasonAttention(season, tasks) {
  const tasksMap = new Map(tasks.map(t => [t.order, t]));

  // Determine which departments are currently required
  const currentRequireAttention = new Set();
  tasks.forEach(task => {
    if (task.status === 'pending') {
      const predecessors = task.precedingTasks || [];
      const allPredecessorsComplete = predecessors.every(predOrder => {
        const predecessor = tasksMap.get(predOrder);
        return predecessor && predecessor.status === 'completed';
      });

      if (allPredecessorsComplete) {
        if (task.responsible && Array.isArray(task.responsible)) {
          task.responsible.forEach(deptName => {
            if (deptName) { // Filter out any null or undefined values
              currentRequireAttention.add(deptName);
            }
          });
        }
      }
    }
  });

  // Update the season's requireAttention field
  season.requireAttention = Array.from(currentRequireAttention);
  // The season is saved in the calling function (updateTaskAndProgressSeason)
}

/**
 * Main function to handle task completion and season progression.
 * @param {Object} snapshot - The Mongoose SeasonSnapshot document.
 * @param {string} taskId - The ID of the task being updated.
 * @param {Object} updateData - The data for the update, e.g., { actualCompletion, remarks }.
 * @returns {Object} - The updated task document.
 */
async function updateTaskAndProgressSeason(userId, snapshot, taskId, updateData) {
  const user = await User.findById(userId).select('role');
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }
  const userRole = user.role.toLowerCase();
  const isAdminOrPlanner = userRole === 'admin' || userRole === 'planner';
  const { actualCompletion, remarks } = updateData;

  const task = snapshot.tasks.find(t => String(t._id) === taskId);
  if (!task) {
    const error = new Error('Task not found in snapshot');
    error.status = 404;
    throw error;
  }

  let hasChanged = false;

  // Handle remarks update
  if (remarks !== undefined && task.remarks !== remarks) {
    const oldRemarks = task.remarks || 'none';
    task.remarks = remarks;
    hasChanged = true;
    await logActivity({
      user: { _id: userId },
      task: task,
      seasonId: snapshot.seasonId,
      action: 'UPDATE_REMARKS',
      details: `Remarks for task "${task.name}" updated from "${oldRemarks}" to "${remarks}".`
    });
  }

    // Handle completion date update
  if (actualCompletion !== undefined) {
    const newActualCompletion = new Date(actualCompletion);
    if (isNaN(newActualCompletion.getTime())) {
      const error = new Error('Invalid actualCompletion date format');
      error.status = 400;
      throw error;
    }

    const oldCompletionDateStr = task.actualCompletion ? moment(task.actualCompletion).format('YYYY-MM-DD') : null;
    const newCompletionDateStr = moment(newActualCompletion).format('YYYY-MM-DD');

    if (newCompletionDateStr !== oldCompletionDateStr) {
      if (task.status === 'completed' && !isAdminOrPlanner) {
        const error = new Error('This task is already completed and cannot be changed.');
        error.status = 403; // Forbidden
        throw error;
      }

      // Validate prerequisites before completing
      const tasksMap = new Map(snapshot.tasks.map(t => [t.order, t]));
      for (const predOrder of task.precedingTasks) {
        const predecessor = tasksMap.get(predOrder);
        if (!predecessor || predecessor.status !== 'completed') {
          const error = new Error(`Cannot complete task. Preceding task '${predecessor.name}' (${predecessor.order}) is not done.`);
          error.status = 400;
          throw error;
        }
      }

      task.actualCompletion = newActualCompletion;
      if (task.status !== 'completed') {
        task.status = 'completed';
      }
      hasChanged = true;
      
      const fromDate = oldCompletionDateStr ? moment(oldCompletionDateStr).format('DD-MMM-YY') : 'none';
      const toDate = moment(newCompletionDateStr).format('DD-MMM-YY');
      await logActivity({
        user: { _id: userId },
        task: task,
        seasonId: snapshot.seasonId,
        action: 'UPDATE_COMPLETION_DATE',
        details: `Actual completion for task "${task.name}" updated from "${fromDate}" to "${toDate}".`
      });
    }
  }

  if (!hasChanged) {
    return { hasChanged: false, updatedTasks: snapshot.tasks, message: 'No changes detected in task.' };
  }

  const season = await Season.findById(snapshot.seasonId);
  if (!season) {
    const error = new Error('Associated season not found');
    error.status = 404;
    throw error;
  }

  recalculateAllTaskDates(snapshot.tasks, season.createdAt);

  // Identify newly actionable tasks and send notifications
  const newlyActionableTasks = [];
  if (task.status === 'completed') {
    snapshot.tasks.forEach(potentialSubsequentTask => {
      if (potentialSubsequentTask.status === 'pending' && potentialSubsequentTask.precedingTasks.includes(task.order)) {
        const allPredecessorsComplete = potentialSubsequentTask.precedingTasks.every(predOrder => {
            const predecessor = snapshot.tasks.find(t => t.order === predOrder);
            return predecessor && predecessor.status === 'completed';
        });

        if (allPredecessorsComplete) {
            newlyActionableTasks.push(potentialSubsequentTask);
        }
      }
    });
  }
  
  if (newlyActionableTasks.length > 0) {
    try {
      const emailSetting = await Setting.findOne({ key: 'emailNotificationsEnabled' });
      if (emailSetting && emailSetting.value === true) {
        for (const subsequentTask of newlyActionableTasks) {
          const responsibleDepartments = subsequentTask.responsible || [];
          const departments = await Department.find({ name: { $in: responsibleDepartments } });
          const departmentIds = departments.map(d => d._id);
          
          if (departmentIds.length > 0) {
            const usersToNotify = await User.find({ department: { $in: departmentIds } }).select('email');
            if (usersToNotify.length > 0) {
              const subject = `Action Required: Task "${subsequentTask.name}" for Season ${season.name}`;
              const seasonUrl = `${process.env.CLIENT_URL}/seasons/${season._id}`;
              const html = `
                <p>Hello,</p>
                <p>A new task now requires your department's attention for the season: <strong style="color:red;">${season.name}</strong>.</p>
                <p>Task: <strong style="color:red;">${subsequentTask.name}</strong></p>
                <p>Please <a href="${seasonUrl}">click here</a> to view the season details.</p>
                <p>Thank you,</p>
                <p>PEBA Production Timeline System</p>
                <p style="font-size:10px;color:#666;">Copyright © 2025 GLENSON_ENCODE SYSTEMS</p>
              `;

              for (const user of usersToNotify) {
                await sendEmail({ seasonId: season._id, to: user.email, subject, html, taskName: subsequentTask.name });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error during email notification process:', error);
    }
  }

  await updateSeasonAttention(season, snapshot.tasks);

  await season.save();
  await snapshot.save();

  
  // Check if all tasks are completed to auto-close the season
  const allTasksCompleted = snapshot.tasks.every(t => t.status === 'completed');

  if (allTasksCompleted && season.status !== 'Closed') {
    const oldStatus = season.status;
    season.status = 'Closed';
    season.requireAttention = []; // Clear requireAttention as per rules for Closed status
    await season.save();

    // Log the auto-closure by the system
    await logActivity({
      user: { _id: userId }, // Action triggered by this user completing the last task
      seasonId: snapshot.seasonId,
      action: 'UPDATE_STATUS',
      details: `Season status automatically updated from "${oldStatus}" to "Closed" as all tasks are now completed.`
    });
  }

  return { hasChanged: true, updatedTasks: snapshot.tasks };
}

module.exports = { updateTaskAndProgressSeason, updateSeasonAttention, recalculateAllTaskDates };
