const mongoose = require('mongoose');

const BuyerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  // Add any other buyer-specific fields if needed in the future
}, { timestamps: true });

module.exports = mongoose.model('Buyer', BuyerSchema);
