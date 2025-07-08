const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const Department = require('../models/Department'); // Make sure this is imported if used, seems to be in PUT route
const Task = require('../models/Task'); // This seems to be for a different 'Task' model, not TaskTemplate for snapshot creation.
const TaskTemplate = require('../models/TaskTemplate');
const SeasonSnapshot = require('../models/SeasonSnapshot');
const Buyer = require('../models/Buyer');
const Season = require('../models/Season'); // Added import for Season model
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/logActivity'); // Added for logging
const { protect, authorize } = require('../middleware/authMiddleware');
const { updateTaskAndProgressSeason, updateSeasonAttention, recalculateAllTaskDates } = require('../utils/taskProgression');
const {
  updateSeasonStatus,
  exportSeasonToExcel,
} = require('../controllers/seasonController');

// --- Multer Configuration for File Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Create a unique filename to avoid overwrites
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });


// @route   POST /api/seasons
// @desc    Create a new season
// @access  Planner or Admin
router.post('/', protect, authorize('Planner', 'Admin'), async (req, res) => {
  const { name, buyerId } = req.body;
  console.log('[POST /api/seasons] Received name:', name, 'buyerId:', buyerId);

  if (!name || !buyerId) {
    return res.status(400).json({ message: 'Season name and buyer ID are required' });
  }

  try {
    const buyerExists = await Buyer.findById(buyerId);
    if (!buyerExists) {
      return res.status(400).json({ message: 'Invalid Buyer ID' });
    }

    console.log('[POST /api/seasons] Checking for existing season with name:', name);
    const existingSeason = await Season.findOne({ name });
    if (existingSeason) {
      return res.status(400).json({ message: `Season with name '${name}' already exists.`});
    }

    console.log('[POST /api/seasons] Creating new Season object with name:', name);
    const season = new Season({
      name,
      buyer: buyerId,
      createdBy: req.user.id,
      status: 'Open',
      requireAttention: [] // Initialize as empty array, will be populated by task logic
    });

    await season.save();

    // --- Create Season Snapshot ---
    const taskTemplates = await TaskTemplate.find({}); // Fetch all, active and inactive

    const snapshotTasks = taskTemplates.map(tt => ({
      order: tt.order,
      name: tt.name,
      responsible: tt.defaultResponsible || [],
      precedingTasks: tt.defaultPrecedingTasks || [],
      // Defensive check: Use template's lead time, or default to 1 day if it's missing (to handle old data).
      leadTime: tt.defaultLeadTime || 1,
      sourceTemplateActiveOnCreation: tt.isActive,
      status: tt.isActive ? 'pending' : 'completed', // If template inactive, mark task as completed
      computedDates: { start: null, end: null } // Initialize computedDates object
    }));

    // Use the new centralized logic to initialize dates and attention status
    recalculateAllTaskDates(snapshotTasks, season.createdAt);
    await updateSeasonAttention(season, snapshotTasks);

    const seasonSnapshot = new SeasonSnapshot({
      seasonId: season._id,
      tasks: snapshotTasks,
      // version: 1, // Defaulted in schema
    });
    await seasonSnapshot.save();
    await season.save();

    // Populate buyer info for the response
    const populatedSeason = await Season.findById(season._id).populate('buyer', 'name');
    res.status(201).json({ ...populatedSeason.toObject(), snapshotId: seasonSnapshot._id });
  } catch (error) {
    console.error('--- CREATE SEASON CRITICAL ERROR ---');
    console.error('Error Message:', error.message);
    console.error('Error Stack:', error.stack);
    console.error('Full Error Object:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message, details: error.errors });
    }
    
    // Send a more informative error response
    res.status(500).json({ 
      message: 'An unexpected server error occurred during season creation.',
      error: error.message, // Send back the actual error message for client-side debugging
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined // Only show stack in dev mode
    });
  }
});

// @route   GET /api/seasons
// @desc    Get all seasons with filtering, sorting, pagination
// @access  Authenticated Users
router.get('/', protect, async (req, res) => {
  try {
    const { searchType, searchValue, sortBy, sortOrder, page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const matchStage = {};
    if (searchType && searchValue && searchValue !== 'all') {
      switch (searchType) {
        case 'seasonName':
          matchStage.name = { $regex: searchValue, $options: 'i' };
          break;
        case 'status':
          matchStage.status = searchValue;
          break;
        case 'buyer':
          if (mongoose.Types.ObjectId.isValid(searchValue)) {
            matchStage.buyer = new mongoose.Types.ObjectId(searchValue);
          } else {
            return res.json({ seasons: [], totalSeasons: 0, page: 1, pages: 0 });
          }
          break;
        case 'requireAttention':
          // The searchValue is expected to be a comma-separated string of department codes
          const departments = searchValue.split(',').filter(dep => dep);
          if (departments.length > 0) {
            matchStage.requireAttention = { $all: departments };
          }
          break;
      }
    }

    const sortStage = {};
    if (sortBy) {
      sortStage[sortBy] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sortStage.createdAt = -1;
    }

    const countPipeline = [{ $match: matchStage }, { $count: 'totalDocs' }];

    const aggregationPipeline = [
      { $match: matchStage },
      { $sort: sortStage },
      { $skip: skip },
      { $limit: limitNum },
      { $lookup: { from: 'buyers', localField: 'buyer', foreignField: '_id', as: 'buyer_docs' } },
      { $unwind: { path: '$buyer_docs', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          status: 1,
          requireAttention: 1,
          createdAt: 1,
          buyer: {
            _id: '$buyer_docs._id',
            name: '$buyer_docs.name'
          }
        }
      }
    ];

    const [seasons, countResult] = await Promise.all([
      Season.aggregate(aggregationPipeline),
      Season.aggregate(countPipeline)
    ]);

    const totalSeasons = countResult.length > 0 ? countResult[0].totalDocs : 0;

    res.json({
      seasons,
      totalSeasons,
      page: pageNum,
      pages: Math.ceil(totalSeasons / limitNum),
    });

  } catch (error) {
    console.error('Get seasons error:', error.message);
    res.status(500).send('Server error');
  }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const season = await Season.findById(req.params.id)
      .populate('buyer', 'name')
      .populate('createdBy', 'firstName lastName email'); // Correctly populate creator's info

    if (!season) {
      return res.status(404).json({ message: 'Season not found' });
    }

    // Fetch the season snapshot which contains the tasks
    const snapshot = await SeasonSnapshot.findOne({ seasonId: req.params.id });

    // Sort tasks by the 'order' field alphabetically for consistent display
    const tasks = snapshot ? snapshot.tasks.sort((a, b) => a.order.localeCompare(b.order)) : [];

    // The frontend expects a `season` object and a `tasks` array.
    res.json({ season: season.toObject({ virtuals: true }), tasks: tasks });

  } catch (error) {
    console.error(`Error fetching season ${req.params.id}:`, error);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Season not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   GET /api/seasons/:id/export
// @desc    Export a season's details to an Excel file
// @access  Protected
router.get('/:id/export', protect, exportSeasonToExcel);

// @route   PUT /api/seasons/:id
// @desc    Update the status of a season
// @access  Protected, Planner/Admin
router.put('/:id/status', protect, authorize('Admin', 'Planner'), updateSeasonStatus);

router.put('/:id', protect, authorize('Planner', 'Admin'), async (req, res) => {
  const { name, buyer, status, requireAttention } = req.body;

  try {
    let season = await Season.findById(req.params.id);
    if (!season) {
      return res.status(404).json({ message: 'Season not found' });
    }

    if (name && name !== season.name) {
      const existingSeason = await Season.findOne({ name: name, _id: { $ne: req.params.id } });
      if (existingSeason) {
        return res.status(400).json({ message: `Season with name '${name}' already exists.` });
      }
      season.name = name;
      await logActivity({
        seasonId: season._id,
        user: req.user,
        action: 'UPDATE_SEASON_NAME',
        details: `Season name changed to "${name}"`
      });
    }

    // Handle buyer update
    if (buyer && buyer.toString() !== season.buyer.toString()) {
      const buyerExists = await Buyer.findById(buyer);
      if (!buyerExists) {
        return res.status(400).json({ message: 'Invalid Buyer ID provided.' });
      }
      season.buyer = buyer;
      await logActivity({
        seasonId: season._id,
        user: req.user,
        action: 'UPDATE_SEASON_BUYER',
        details: `Season buyer changed to "${buyerExists.name}"`
      });
    }

    if (status) {
        // Add validation for allowed status values if not using enum strictly in model
        season.status = status;
    }
    if (req.body.hasOwnProperty('requireAttention')) { // Check if requireAttention is part of the request body
      if (requireAttention === null || requireAttention === '') { // Allow setting to null or empty string to clear it
        season.requireAttention = null;
      } else {
        // Validate if requireAttention is one of the allowed enum values if necessary, though mongoose handles this.
        // For now, directly assign. If it was a ref to Department, we'd findById.
        season.requireAttention = requireAttention;
      }
    }

    await season.save();
    const populatedSeason = await Season.findById(season._id).populate('buyer', 'name'); // Removed populate for needAttention
    res.json(populatedSeason);
  } catch (error) {
    console.error('Update season error:', error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Season, Buyer or Department not found' });
    }
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/seasons/:id
// @desc    Delete a season
// @access  Planner or Admin
router.delete('/:id', protect, authorize('Planner', 'Admin'), async (req, res) => {
  try {
    const season = await Season.findById(req.params.id);
    if (!season) {
      return res.status(404).json({ message: 'Season not found' });
    }

    // Check if there are any tasks associated with this season
    const tasksCount = await Task.countDocuments({ season: req.params.id });
    if (tasksCount > 0) {
      return res.status(400).json({ message: 'Cannot delete season with active tasks. Please delete tasks first or archive the season.' });
    }

    await season.deleteOne();
    res.json({ message: 'Season removed' });
  } catch (error) {
    console.error('Delete season error:', error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Season not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/seasons/:seasonId/tasks/:taskId
// @desc    Update a task within a season (e.g., mark as complete, add remarks)
// @access  Protect, Planner, Admin, or responsible User
router.put('/:seasonId/tasks/:taskId', protect, async (req, res) => {
  const { seasonId, taskId } = req.params;
  const updateData = req.body; // e.g., { actualCompletion: '...', remarks: '...' }
  const userId = req.user.id;

  try {
    // First, check the season's status to enforce business rules
    const season = await Season.findById(seasonId);
    if (!season) {
      return res.status(404).json({ message: 'Season not found' });
    }

    if (season.status !== 'Open') {
      return res.status(403).json({ message: `Tasks cannot be updated. Season status is '${season.status}'.` });
    }

    const snapshot = await SeasonSnapshot.findOne({ seasonId: seasonId });
    if (!snapshot) {
      return res.status(404).json({ message: 'Season snapshot not found' });
    }

    const task = snapshot.tasks.find(t => String(t._id) === taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found in snapshot' });
    }

    // Authorization check
    const userDeptDoc = await Department.findById(req.user.department);
    const userDepartmentName = userDeptDoc ? userDeptDoc.name : null;
    if (!userDepartmentName) {
      return res.status(400).json({ message: 'User department not found.' });
    }

    const isResponsible = task.responsible.includes(userDepartmentName);
    const isPlannerOrAdmin = req.user.role === 'Planner' || req.user.role === 'Admin';
    if (!isResponsible && !isPlannerOrAdmin) {
      return res.status(403).json({ message: 'User not authorized to update this task' });
    }

    // Call the centralized logic to update the task and progress the season
    const result = await updateTaskAndProgressSeason(
      userId,
      snapshot,
      taskId,
      updateData
    );

    // The centralized function returns null if no changes were made.
    if (!result || !result.hasChanged) {
      const originalSeason = await Season.findById(seasonId)
        .populate('buyer', 'name')
        .populate('createdBy', 'firstName lastName email');

      return res.json({
        message: 'No changes detected in task.',
        season: originalSeason.toObject({ virtuals: true }),
        tasks: snapshot.tasks.sort((a, b) => a.order.localeCompare(b.order))
      });
    }

    // After the update, re-fetch the season to get the latest state
    const updatedSeason = await Season.findById(seasonId)
      .populate('buyer', 'name')
      .populate('createdBy', 'firstName lastName email');
    
    // The result from the progression function contains the updated tasks array
    const sortedTasks = result.updatedTasks.sort((a, b) => a.order.localeCompare(b.order));

    res.json({
      message: 'Task updated successfully',
      season: updatedSeason.toObject({ virtuals: true }),
      tasks: sortedTasks
    });

  } catch (error) {
    console.error(`Error updating task ${taskId} in season ${seasonId}:`, error);
    res.status(500).json({ message: 'Server error while updating task.', error: error.message });
  }
});

// @route   POST /api/seasons/:seasonId/tasks/:taskId/attachments
// @desc    Upload an attachment for a specific task
// @access  Protect, Planner, Admin, or responsible User
router.post('/:seasonId/tasks/:taskId/attachments', protect, upload.single('attachment'), async (req, res) => {
    const { seasonId, taskId } = req.params;
    const user = req.user;

    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    try {
        const snapshot = await SeasonSnapshot.findOne({ seasonId });
        if (!snapshot) {
            return res.status(404).json({ message: 'Season snapshot not found.' });
        }

        const task = snapshot.tasks.find(t => String(t._id) === taskId);
        if (!task) {
            return res.status(404).json({ message: 'Task not found.' });
        }

        // Authorization check (similar to task update)
        const userDeptDoc = await Department.findById(user.department);
        const userDepartmentName = userDeptDoc ? userDeptDoc.name : null;
        if (!userDepartmentName) return res.status(400).json({ message: 'User department not found.' });

        const isResponsible = task.responsible.includes(userDepartmentName);
        const isPlannerOrAdmin = user.role === 'Planner' || user.role === 'Admin';
        if (!isResponsible && !isPlannerOrAdmin) {
            // Clean up uploaded file if user is not authorized
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ message: 'User not authorized to upload attachments for this task.' });
        }

        const attachment = {
            filename: req.file.originalname,
            path: req.file.path,
            mimetype: req.file.mimetype,
            uploadedBy: user.id
        };

        if (!task.attachments) {
            task.attachments = [];
        }
        task.attachments.push(attachment);

        await snapshot.save();

        // Log the activity
        await logActivity({
            seasonId,
            task,
            user,
            action: 'UPLOAD_ATTACHMENT',
            details: { filename: attachment.filename }
        });

        res.status(201).json({ message: 'Attachment uploaded successfully.', task });

    } catch (error) {
        console.error('Error uploading attachment:', error);
        // Clean up uploaded file on error
        fs.unlinkSync(req.file.path);
        res.status(500).json({ message: 'Server error during attachment upload.', error: error.message });
    }
});

// @route   GET /api/seasons/:seasonId/tasks/:taskId/attachments/:attachmentId
// @desc    Download a specific attachment for a task
// @access  Authenticated Users
router.get('/:seasonId/tasks/:taskId/attachments/:attachmentId', protect, async (req, res) => {
  const { seasonId, taskId, attachmentId } = req.params;

  try {
    const snapshot = await SeasonSnapshot.findOne({ seasonId });
    if (!snapshot) {
      return res.status(404).json({ message: 'Season snapshot not found' });
    }

    const task = snapshot.tasks.find(t => String(t._id) === taskId);
    if (!task || !task.attachments || task.attachments.length === 0) {
      return res.status(404).json({ message: 'Task or attachments not found' });
    }

    const attachment = task.attachments.find(a => String(a._id) === attachmentId);
    if (!attachment) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    const filePath = path.resolve(attachment.path);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', attachment.mimetype);
      res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: 'Attachment file not found on server.' });
    }

  } catch (error) {
    console.error('Error downloading attachment:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   DELETE /api/seasons/:seasonId/tasks/:taskId/attachments/:attachmentId
// @desc    Delete an attachment from a task
// @access  Protect, Planner, Admin, or responsible User
router.delete('/:seasonId/tasks/:taskId/attachments/:attachmentId', protect, async (req, res) => {
  const { seasonId, taskId, attachmentId } = req.params;
  const user = req.user;

  try {
    const snapshot = await SeasonSnapshot.findOne({ seasonId });
    if (!snapshot) return res.status(404).json({ message: 'Season snapshot not found' });

    const task = snapshot.tasks.find(t => String(t._id) === taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const attachmentIndex = task.attachments.findIndex(a => String(a._id) === attachmentId);
    if (attachmentIndex === -1) return res.status(404).json({ message: 'Attachment not found' });

    // --- Authorization Check ---
    const userIsAdminOrPlanner = user.role === 'Admin' || user.role === 'Planner';
    const userDepartment = await Department.findById(user.department).select('code');
    const userIsResponsible = userDepartment && task.responsible.includes(userDepartment.code);

    if (!userIsAdminOrPlanner && !userIsResponsible) {
      return res.status(403).json({ message: 'Forbidden: You are not authorized to delete attachments for this task.' });
    }

    const [deletedAttachment] = task.attachments.splice(attachmentIndex, 1);

    // Delete the physical file
    if (fs.existsSync(deletedAttachment.path)) {
      fs.unlinkSync(deletedAttachment.path);
    }

    await snapshot.save();

    // Log the activity
    await logActivity({
      seasonId,
      task,
      user,
      action: 'DELETE_ATTACHMENT',
      details: `Deleted file: ${deletedAttachment.filename}`
    });

    res.json({ message: 'Attachment deleted successfully', task });
  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   GET /api/seasons/:seasonId/logs
// @desc    Get all activity logs for a season
// @access  Authenticated Users
router.get('/:seasonId/logs', protect, async (req, res) => {
  try {
    // Fetch logs and populate the user, and nestedly populate the user's department
    const logs = await ActivityLog.find({ seasonId: req.params.seasonId })
      .populate({
        path: 'user', // Populate the whole user object
        populate: {   // And within the user, populate their department
          path: 'department',
          select: 'name' // Only get the department's name
        }
      })
      .sort({ createdAt: -1 })
      .lean(); // Use .lean() for better performance on read-only queries

    res.json(logs);
  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({ message: 'Server error while fetching logs.' });
  }
});

module.exports = router;
