const mongoose = require('mongoose');

const SeasonSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Season name is required'],
    trim: true,
    unique: true
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: [true, 'Buyer is required']
  },
  status: {
    type: String,
    enum: ['Open', 'Closed', 'On-Hold', 'Canceled'], // Updated enum
    default: 'Open' // Updated default
  },
  // 'dateCreated' is handled by timestamps: true
  requireAttention: {
    type: [String],
    enum: ['PD', 'P&S', 'AM', 'QA', 'Logistics', 'Production'], // Include all possible department codes
    default: []
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Creator user is required']
  }
}, { timestamps: true });

module.exports = mongoose.model('Season', SeasonSchema);
