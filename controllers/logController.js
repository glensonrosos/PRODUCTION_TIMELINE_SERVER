const EmailLog = require('../models/EmailLog');

/**
 * @route   DELETE /api/logs/email
 * @desc    Delete all email logs
 * @access  Admin, Planner
 */
const clearEmailLogs = async (req, res) => {
  try {
    await EmailLog.deleteMany({});
    res.status(200).json({ message: 'All email logs have been successfully cleared.' });
  } catch (error) {
    console.error('Error clearing email logs:', error);
    res.status(500).json({ message: 'Server error while clearing email logs.' });
  }
};

module.exports = {
  clearEmailLogs,
};
