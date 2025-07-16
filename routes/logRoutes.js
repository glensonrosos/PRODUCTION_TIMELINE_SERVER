const express = require('express');
const router = express.Router();
const { clearEmailLogs } = require('../controllers/logController');
const { protect, authorize } = require('../middleware/authMiddleware');

// @route   DELETE /api/logs/email
// @desc    Clear all email logs
// @access  Admin, Planner
router.delete('/email', protect, authorize('Admin', 'Planner'), clearEmailLogs);

module.exports = router;
