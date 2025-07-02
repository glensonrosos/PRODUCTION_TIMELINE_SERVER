const ActivityLog = require('../models/ActivityLog');

/**
 * Creates a log entry for a task-related activity.
 * @param {object} options - The options for logging.
 * @param {string} options.seasonId - The ID of the season.
 * @param {object} options.task - The task object being modified.
 * @param {object} options.user - The user performing the action (must have _id).
 * @param {string} options.action - The type of action being performed.
 * @param {object|string} options.details - The details of the change.
 */
const logActivity = async ({ seasonId, task, user, action, details }) => {
  try {
    if (!user || !user._id) {
      console.error('Failed to log activity: A user object with an _id is required.');
      return; // Exit without throwing to avoid blocking the main operation
    }

    // Format the task name as "Order - Name" if task is provided
    const formattedTaskName = task && task.order && task.name 
      ? `${task.order} - ${task.name}` 
      : (task ? task.name : undefined);

    // Construct a descriptive string for the 'details' field
    let detailsString = '';
    if (typeof details === 'string') {
      detailsString = details;
    } else if (typeof details === 'object' && details !== null) {
      if (details.change) { // For status changes
        detailsString = details.change;
      } else if (details.filename) { // For attachments
        detailsString = `File: ${details.filename}`;
      } else if (details.field) { // For other field updates like remarks
        detailsString = `Updated ${details.field}.`;
      }
    }

    const logEntry = new ActivityLog({
      seasonId,
      user: user._id,
      action,
      details: detailsString,
      taskId: task ? task._id : undefined,
      taskName: formattedTaskName,
      attachmentId: details && details.attachmentId ? details.attachmentId : undefined,
    });

    await logEntry.save();
    if (formattedTaskName) {
      console.log(`Activity logged for task '${formattedTaskName}': ${action}`);
    } else {
      console.log(`Activity logged: ${action}`);
    }
  } catch (error) {
    console.error('Failed to log activity:', error.message);
  }
};

module.exports = logActivity;
