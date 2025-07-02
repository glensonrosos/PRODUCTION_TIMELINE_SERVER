const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams allows us to access :seasonId from parent router
const mongoose = require('mongoose');
const Task = require('../models/Task');
const Season = require('../models/Season');
const Department = require('../models/Department');
const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../config/multerConfig'); // For file uploads
const emailService = require('../services/emailService');
const { updateSeasonAttention } = require('../utils/taskProgression'); // Import the utility function

// Helper function to calculate target dates
async function calculateTargetDates(task, seasonId) {
    if (!task.precedingTasks || task.precedingTasks.length === 0) {
        const season = await Season.findById(seasonId);
        task.computedDates.start = (season && season.createdAt) ? new Date(season.createdAt) : new Date();
    } else {
        const predecessors = await Task.find({ '_id': { $in: task.precedingTasks } });

        if (predecessors.some(p => !p.actualCompletion)) {
            task.computedDates = { start: null, end: null };
            return;
        }

        const completionDates = predecessors.map(p => new Date(p.actualCompletion).getTime());
        const latestCompletionTimestamp = Math.max(...completionDates);
        task.computedDates.start = new Date(latestCompletionTimestamp);
    }

    if (task.computedDates.start && typeof task.leadTime === 'number' && task.leadTime >= 0) {
        const endDate = new Date(task.computedDates.start);
        endDate.setDate(endDate.getDate() + task.leadTime);
        task.computedDates.end = endDate;
    } else {
        task.computedDates.end = null;
    }
}

// Helper function to update subsequent tasks
async function updateSubsequentTasks(completedTaskId, completionDate, seasonId) {
    const tasksToUpdate = await Task.find({ season: seasonId, precedingTasks: completedTaskId, status: { $ne: 'Completed' } });

    for (const task of tasksToUpdate) {
        // For each subsequent task, check if ALL its predecessors are now complete
        const allPredecessorsComplete = await checkAllPredecessorsComplete(task);
        
        if (allPredecessorsComplete) {
            // Recalculate the start date based on the LATEST completion of ALL its predecessors
            await calculateTargetDates(task, seasonId);
            
            // Potentially change status from Pending to In Progress if it was waiting
            if (task.status === 'Pending') {
                task.status = 'In Progress';
            }
            
            await task.save();
            
            // Notify for this newly activated/updated task
            const season = await Season.findById(seasonId);
            const completedTask = await Task.findById(completedTaskId);
            if (season && completedTask) {
                emailService.notifyPrecedingTaskCompleted(task, completedTask, season);
            }
        }
    }
}

// Helper: Check if all preceding tasks for a given task are complete
async function checkAllPredecessorsComplete(task) {
    if (!task.precedingTasks || task.precedingTasks.length === 0) return true;
    const predecessors = await Task.find({ _id: { $in: task.precedingTasks } });
    if (predecessors.length !== task.precedingTasks.length) {
        console.error(`Task ${task.orderSequence} has missing predecessor tasks in the database.`);
        return false; // Or handle this error more gracefully
    }
    return predecessors.every(pt => pt.status === 'Completed');
}

// Helper: Check if a season can be closed (all tasks completed)
async function checkAndCloseSeason(seasonId) {
    const tasks = await Task.find({ season: seasonId });
    if (tasks.length > 0 && tasks.every(t => t.status === 'Completed')) {
        const season = await Season.findById(seasonId);
        if (season && season.status !== 'Closed') {
            season.status = 'Closed';
            await season.save();
            // TODO: Notify relevant parties about season closure if needed
        }
    }
}

// @route   POST /api/seasons/:seasonId/tasks
// @desc    Create a new task for a season
// @access  Planner or Admin
router.post('/', protect, authorize('Planner', 'Admin'), async (req, res) => {
    const { seasonId } = req.params;
    const { orderSequence, taskName, responsibleDepartmentIds, precedingTaskIds, leadTime, remarks } = req.body;

    if (!orderSequence || !taskName || !responsibleDepartmentIds || !leadTime === null) {
        return res.status(400).json({ message: 'Order, Name, Responsible Dept(s), and Lead Time are required.' });
    }

    try {
        const season = await Season.findById(seasonId);
        if (!season) return res.status(404).json({ message: 'Season not found' });
        if (season.status === 'Closed' || season.status === 'Canceled') {
            return res.status(400).json({ message: `Cannot add tasks to a ${season.status.toLowerCase()} season.` });
        }

        // Validate responsible departments
        const departments = await Department.find({ _id: { $in: responsibleDepartmentIds } });
        if (departments.length !== responsibleDepartmentIds.length) {
            return res.status(400).json({ message: 'One or more responsible department IDs are invalid.' });
        }
        // Validate preceding tasks (if any)
        if (precedingTaskIds && precedingTaskIds.length > 0) {
            const pTasks = await Task.find({ _id: { $in: precedingTaskIds }, season: seasonId });
            if (pTasks.length !== precedingTaskIds.length) {
                return res.status(400).json({ message: 'One or more preceding task IDs are invalid or not in this season.' });
            }
        }

        const newTask = new Task({
            season: seasonId,
            orderSequence,
            taskName,
            responsibleDepartments: responsibleDepartmentIds,
            precedingTasks: precedingTaskIds || [],
            leadTime,
            remarks,
            status: 'Pending' // Initial status
        });

        await calculateTargetDates(newTask, seasonId);
        // If no preceding tasks, or if all preceding tasks are already complete, it can be 'In Progress'
        const allPredecessorsComplete = await checkAllPredecessorsComplete(newTask);
        if (allPredecessorsComplete) {
            newTask.status = 'In Progress';
        }

        await newTask.save();
        const populatedTask = await Task.findById(newTask._id)
                                    .populate('responsibleDepartments', 'name')
                                    .populate('precedingTasks', 'orderSequence taskName');
        
        emailService.notifyNewTaskAssignment(populatedTask, season);

        res.status(201).json(populatedTask);
    } catch (error) {
        console.error('Create task error:', error);
        if (error.code === 11000) { // Duplicate key error (e.g. orderSequence in season)
             return res.status(400).json({ message: 'Task with this Order Sequence already exists in this season.' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/seasons/:seasonId/tasks
// @desc    Get all tasks for a specific season
// @access  Authenticated Users (filtered by department for 'User' role)
router.get('/', protect, async (req, res) => {
    const { seasonId } = req.params;
    try {
        const season = await Season.findById(seasonId);
        if (!season) return res.status(404).json({ message: 'Season not found' });

        let tasksQuery = Task.find({ season: seasonId })
            .populate('responsibleDepartments', 'name')
            .populate('precedingTasks', 'orderSequence taskName status')
            .populate('attachments.uploadedBy', 'firstName lastName') // If you add uploadedBy to attachments
            .sort({ orderSequence: 1 });

        let tasks = await tasksQuery;

        if (req.user.role === 'User') {
            tasks = tasks.filter(task => 
                task.responsibleDepartments.some(dept => dept._id.equals(req.user.department))
            );
        }
        res.json(tasks);
    } catch (error) {
        console.error('Get tasks for season error:', error);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/tasks/:taskId  (Note: This is a top-level route, not nested under seasons for simplicity of access)
// @desc    Get a single task by ID
// @access  Authenticated Users (with department check for 'User' role)
router.get('/:taskId', protect, async (req, res) => {
    try {
        const task = await Task.findById(req.params.taskId)
            .populate('responsibleDepartments', 'name')
            .populate('precedingTasks', 'orderSequence taskName status actualCompletionDate')
            .populate('season', 'seasonName buyer status') // Populate season details
            .populate('attachments.uploadedBy', 'firstName lastName');

        if (!task) return res.status(404).json({ message: 'Task not found' });

        // Authorization: User can only see tasks for their department
        if (req.user.role === 'User' && !task.responsibleDepartments.some(dept => dept._id.equals(req.user.department))) {
            return res.status(403).json({ message: 'Not authorized to view this task' });
        }

        res.json(task);
    } catch (error) {
        console.error('Get task by ID error:', error);
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Task not found' });
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/tasks/:taskId
// @desc    Update a task (completion, remarks, status, attachments)
// @access  Users (for their dept tasks), Planners, Admins
router.put('/:taskId', protect, upload.array('attachments', 5), async (req, res) => { // 'attachments' is field name, max 5 files
    const { taskId } = req.params;
    const { remarks, status, actualCompletion, leadTime, taskName, orderSequence, responsibleDepartmentIds, precedingTaskIds, blockedByTaggingTask } = req.body;

    try {
        let task = await Task.findById(taskId).populate('season');
        if (!task) return res.status(404).json({ message: 'Task not found' });

        const season = await Season.findById(task.season._id); // Get fresh season object
        if (!season) return res.status(404).json({ message: 'Associated season not found' });
        if (season.status === 'Closed' || season.status === 'Canceled') {
             if (req.user.role !== 'Admin') { // Admin might be allowed to edit remarks on closed tasks
                return res.status(400).json({ message: `Cannot modify tasks in a ${season.status.toLowerCase()} season.` });
             }
        }

        // Authorization: Who can edit what?
        const userRole = req.user.role?.toLowerCase();
        const canEditCoreDetails = userRole === 'admin' || userRole === 'planner';
        const isResponsibleUser = task.responsibleDepartments.some(deptId => deptId.equals(req.user.department));

        if (!canEditCoreDetails && !isResponsibleUser) {
            return res.status(403).json({ message: 'Not authorized to update this task' });
        }

        // Check if task is editable (all preceding tasks completed)
        const allPredecessorsComplete = await checkAllPredecessorsComplete(task);
        if (!allPredecessorsComplete && status === 'Completed') {
            return res.status(400).json({ message: 'Cannot complete task: Not all preceding tasks are completed.' });
        }
        // Users can only edit specific fields if it's their task and predecessors are done (or if it's blocked)
        if (req.user.role === 'User' && !allPredecessorsComplete && task.status !== 'Blocked' && task.status !== 'Cannot Continue'){
            if(status || actualCompletionDate){ // User trying to complete/change status of a non-active task
                 return res.status(403).json({ message: 'Task is not yet active. Preceding tasks must be completed.' });
            }
        }
        if (task.status === 'Completed' && !canEditCoreDetails) {
             return res.status(400).json({ message: 'Completed task cannot be edited by users. Contact Planner/Admin.' });
        }

        // Planner/Admin specific updates
        if (canEditCoreDetails) {
            if (taskName) task.taskName = taskName;
            if (orderSequence) task.orderSequence = orderSequence; // Needs careful validation for uniqueness if changed
            if (leadTime !== undefined) task.leadTime = parseInt(leadTime);
            if (responsibleDepartmentIds) {
                const depts = await Department.find({ _id: { $in: JSON.parse(responsibleDepartmentIds) } });
                if (depts.length !== JSON.parse(responsibleDepartmentIds).length) return res.status(400).json({ message: 'Invalid resp dept IDs'});
                task.responsibleDepartments = JSON.parse(responsibleDepartmentIds);
            }
            if (precedingTaskIds) {
                const pTasks = await Task.find({ _id: { $in: JSON.parse(precedingTaskIds) }, season: task.season._id });
                if (pTasks.length !== JSON.parse(precedingTaskIds).length) return res.status(400).json({ message: 'Invalid preceding task IDs'});
                task.precedingTasks = JSON.parse(precedingTaskIds);
            }
        }

        // Common updates (remarks, status, completion)
        if (remarks !== undefined) task.remarks = remarks;
        if (blockedByTaggingTask === 'null') { // Handle unsetting the tag
            task.blockedByTaggingTask = null;
        } else if (blockedByTaggingTask) {
            const taggedTaskExists = await Task.findById(blockedByTaggingTask);
            if (!taggedTaskExists) return res.status(400).json({ message: 'Invalid task ID for blockedByTaggingTask.' });
            task.blockedByTaggingTask = blockedByTaggingTask;
        }

        const oldStatus = task.status;
        let wasJustCompleted = false;

        // Set new status and determine if it was just completed
        if (status) {
            task.status = status;
            if (status === 'Completed' && oldStatus !== 'Completed') {
                wasJustCompleted = true;
                task.actualCompletion = actualCompletion ? new Date(actualCompletion) : new Date();
            }
        }

        // Handle status reversions or blocking
        if (oldStatus === 'Completed' && status !== 'Completed') {
            task.actualCompletion = null;
            // TODO: Logic to revert subsequent tasks
        } else if (status === 'Blocked' || status === 'Cannot Continue') {
            if(oldStatus === 'Completed') task.actualCompletion = null; 
            emailService.notifyTaskBlocked(task, season, req.user);
        }

        // Handle file attachments
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                task.attachments.push({
                    fileName: file.originalname,
                    filePath: file.path,
                    fileType: file.mimetype,
                });
            });
        }
        
        // Recalculate target dates for the current task ONLY if its own dependencies have actually changed
        console.log('--- [Backend Update Task] ---');
        console.log('Received Request Body:', req.body);

        const leadTimeChanged = leadTime !== undefined && task.leadTime !== parseInt(leadTime, 10);

        let precedingTasksChanged = false;
        if (precedingTaskIds !== undefined) {
            const storedIds = task.precedingTasks.map(id => id.toString()).sort();
            const incomingIds = [...precedingTaskIds].sort();
            precedingTasksChanged = storedIds.join(',') !== incomingIds.join(',');
        }

        console.log(`leadTime from request: ${leadTime}`);
        console.log(`task.leadTime from DB: ${task.leadTime}`);
        console.log(`leadTimeChanged flag: ${leadTimeChanged}`);

        console.log(`precedingTaskIds from request:`, precedingTaskIds);
        console.log(`task.precedingTasks from DB:`, task.precedingTasks.map(id => id.toString()));
        console.log(`precedingTasksChanged flag: ${precedingTasksChanged}`);

        // Must update the task object with new dependencies BEFORE recalculating
        if (canEditCoreDetails) {
            if (leadTimeChanged) {
                task.leadTime = parseInt(leadTime, 10);
            }
            if (precedingTasksChanged) {
                // This assumes precedingTaskIds from the body is an array of valid ObjectIds/strings
                task.precedingTasks = precedingTaskIds;
            }
        }

        if (canEditCoreDetails && (leadTimeChanged || precedingTasksChanged)) {
            console.log('!!! Recalculating self. This is likely the cause of the bug. !!!');
            await calculateTargetDates(task, task.season._id);
        } else {
            console.log('>>> Not recalculating self. This is the correct path.');
        }
        console.log('-----------------------------');

        // --- Save the task FIRST to prevent race conditions ---
        // --- Save the task FIRST to prevent race conditions ---
        const updatedTask = await task.save();

        // --- AFTER saving, perform actions that depend on the new state ---
        if (wasJustCompleted) {
            console.log(`Task ${updatedTask.orderSequence} was just completed. Triggering subsequent updates.`);
            // Now that the completion date is saved, update subsequent tasks
            await updateSubsequentTasks(updatedTask._id, updatedTask.actualCompletion, updatedTask.season._id);

            // Update season attention status
            const parentSeasonToUpdate = await Season.findById(updatedTask.season._id);
            if (parentSeasonToUpdate && parentSeasonToUpdate.status !== 'Closed' && parentSeasonToUpdate.status !== 'Canceled') {
                const allTasksInSeason = await Task.find({ season: updatedTask.season._id });
                await updateSeasonAttention(parentSeasonToUpdate, allTasksInSeason);
                await parentSeasonToUpdate.save();
            }
            
            // Check if the season can be closed
            await checkAndCloseSeason(updatedTask.season._id);
        }

        // Populate and send the final response
        const populatedTask = await Task.findById(updatedTask._id)
                                        .populate('responsibleDepartments', 'name')
                                        .populate('precedingTasks', 'orderSequence taskName status')
                                        .populate('season', 'seasonName buyer status');
        res.json(populatedTask);

    } catch (error) {
        console.error('Update task error:', error);
        // Multer error (e.g. file type not allowed)
        if (error.message && error.message.startsWith('Error: File type not allowed')) {
            return res.status(400).json({ message: error.message });
        }
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Task or related entity not found' });
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/tasks/:taskId/attachments/:attachmentId
// @desc    Delete a specific attachment from a task
// @access  User who uploaded or Planner/Admin
router.delete('/:taskId/attachments/:attachmentId', protect, async (req, res) => {
    const { taskId, attachmentId } = req.params;
    try {
        const task = await Task.findById(taskId);
        if (!task) return res.status(404).json({ message: 'Task not found' });

        const attachment = task.attachments.id(attachmentId);
        if (!attachment) return res.status(404).json({ message: 'Attachment not found' });

        // Authorization: User who uploaded (if tracked), or Planner/Admin, or user responsible for task
        const canDelete = req.user.role === 'Admin' || req.user.role === 'Planner' || 
                          (task.responsibleDepartments.some(deptId => deptId.equals(req.user.department)));
                          // || (attachment.uploadedBy && attachment.uploadedBy.equals(req.user.id));

        if (!canDelete) {
            return res.status(403).json({ message: 'Not authorized to delete this attachment' });
        }

        // TODO: Delete file from filesystem (fs.unlink)
        // const filePath = attachment.filePath; -> requires storing absolute path or resolving it
        // For now, just removing from DB:
        attachment.remove(); // Mongoose subdocument removal
        await task.save();

        res.json({ message: 'Attachment removed successfully' });
    } catch (error) {
        console.error('Delete attachment error:', error);
        res.status(500).send('Server Error');
    }
});


// @route   DELETE /api/tasks/:taskId
// @desc    Delete a task
// @access  Planner or Admin
router.delete('/:taskId', protect, authorize('Planner', 'Admin'), async (req, res) => {
    const { taskId } = req.params;
    try {
        const task = await Task.findById(taskId);
        if (!task) return res.status(404).json({ message: 'Task not found' });

        // Check if this task is a predecessor to any other tasks
        const subsequentTasks = await Task.find({ precedingTasks: taskId });
        if (subsequentTasks.length > 0) {
            return res.status(400).json({ 
                message: 'Cannot delete task: It is a predecessor for other tasks. Please update those tasks first.',
                dependentTasks: subsequentTasks.map(t => ({ id: t._id, name: t.taskName, order: t.orderSequence }))
            });
        }

        // TODO: Delete associated attachments from filesystem

        await task.deleteOne();
        res.json({ message: 'Task removed successfully' });
    } catch (error) {
        console.error('Delete task error:', error);
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Task not found' });
        res.status(500).send('Server Error');
    }
});

module.exports = router;
