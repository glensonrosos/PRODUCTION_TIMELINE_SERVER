const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
  season: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Season',
    required: true,
  },
  recipient: {
    type: String,
    required: true,
  },
  subject: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['sent', 'failed'],
    required: true,
  },
  error: {
    type: String, // Store error message if sending failed
  },
  sentAt: {
    type: Date,
    default: Date.now,
  },
});

const EmailLog = mongoose.model('EmailLog', emailLogSchema);

module.exports = EmailLog;
