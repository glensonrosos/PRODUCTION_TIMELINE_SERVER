const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const Setting = require('../models/Setting');
const EmailLog = require('../models/EmailLog');
const Season = require('../models/Season');
const SeasonSnapshot = require('../models/SeasonSnapshot');
const User = require('../models/User');
const Department = require('../models/Department');
const { sendEmail } = require('../utils/emailService');

// @desc    Get all email logs
// @route   GET /api/settings/email-logs
// @access  Private/Planner/Admin
router.get('/email-logs', protect, authorize('Planner', 'Admin'), async (req, res) => {
  try {
    const logs = await EmailLog.find().populate('season', 'name').sort({ sentAt: -1 });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @desc    Get all settings
// @route   GET /api/settings
// @access  Private/Planner/Admin
router.get('/', protect, authorize('Planner', 'Admin'), async (req, res) => {
  try {
    const settings = await Setting.find({});
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @desc    Update a setting
// @route   PUT /api/settings/:key
// @access  Private/Planner/Admin
router.put('/:key', protect, authorize('Planner', 'Admin'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const setting = await Setting.findOneAndUpdate(
      { key },
      { value, lastModifiedBy: req.user.id },
      { new: true, upsert: true } // upsert: create if it doesn't exist
    );

    res.json(setting);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @desc    Resend notifications for seasons requiring attention
// @route   POST /api/settings/resend-notifications
// @access  Private/Planner/Admin
router.post('/resend-notifications', protect, authorize('Planner', 'Admin'), async (req, res) => {
  try {
    const emailSetting = await Setting.findOne({ key: 'emailNotificationsEnabled' });
    if (!emailSetting || emailSetting.value !== true) {
      return res.status(400).json({ message: 'Email notifications are currently disabled.' });
    }

    const seasonsToNotify = await Season.find({ 
      requireAttention: { $exists: true, $ne: [] } 
    }).lean();

    if (seasonsToNotify.length === 0) {
      return res.json({ message: 'No seasons currently require attention.' });
    }

    let emailsSent = 0;
    for (const season of seasonsToNotify) {
      const snapshot = await SeasonSnapshot.findOne({ seasonId: season._id }).lean();
      if (!snapshot) continue;

      const tasksMap = new Map(snapshot.tasks.map(t => [t.order, t]));
      const actionableTasks = snapshot.tasks.filter(task => {
        if (task.status !== 'pending') return false;
        if (!task.precedingTasks || task.precedingTasks.length === 0) return true;
        return task.precedingTasks.every(predOrder => {
          const predecessor = tasksMap.get(predOrder);
          return predecessor && predecessor.status === 'completed';
        });
      }).map(t => t.name);

      if (actionableTasks.length === 0) continue;

      const departments = await Department.find({ name: { $in: season.requireAttention } }).select('_id');
      const departmentIds = departments.map(d => d._id);
      const usersToNotify = await User.find({ department: { $in: departmentIds } }).select('email');

      const subject = `REMINDER: Action Required for Season: ${season.name}`;
      const seasonUrl = `${process.env.CLIENT_URL}/seasons/${season._id}`;
      const html = `
        <p>Hello,</p>
        <p>This is a reminder that your attention is required for the season: <strong  style="color:red;">${season.name}</strong>.</p>
        <p>The following task(s) are ready for your department's action: <strong  style="color:red;">${actionableTasks.join(', ')}</strong>.</p>
        <p>Please <a href=\"${seasonUrl}\">click here</a> to view the season details and take the necessary actions.</p>
        <p>Thank you,</p>
        <p>PRODUCTION Timeline System</p>
        <p style="font-size:10px;color:#666;">Copyright © 2025 GLENSON_ENCODE SYSTEMS</p>
      `;

      for (const user of usersToNotify) {
        try {
          await sendEmail({ seasonId: season._id, to: user.email, subject, html });
          emailsSent++;
        } catch (emailError) {
          console.error(`Failed to resend email to ${user.email} for season ${season.name}:`, emailError);
        }
      }
    }

    res.json({ message: `Successfully resent ${emailsSent} notification(s).` });

  } catch (error) {
    console.error('Error resending notifications:', error);
    res.status(500).json({ message: 'Server Error while resending notifications.' });
  }
});

module.exports = router;
