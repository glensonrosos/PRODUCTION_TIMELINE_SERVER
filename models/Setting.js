const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true, // Each setting key must be unique
    trim: true,
  },
  value: {
    type: mongoose.Schema.Types.Mixed, // Allows storing different types of values (e.g., boolean, string, object)
    required: true,
  },
  description: {
    type: String,
    trim: true,
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt timestamps
});

// Seed the initial setting if it doesn't exist
settingSchema.statics.initialize = async function () {
  const existingSetting = await this.findOne({ key: 'emailNotificationsEnabled' });
  if (!existingSetting) {
    await this.create({
      key: 'emailNotificationsEnabled',
      value: true, // Default to enabled
      description: 'Controls whether automated email notifications are sent to users.',
    });
    console.log('Initialized default setting: emailNotificationsEnabled');
  }
};

const Setting = mongoose.model('Setting', settingSchema);

module.exports = Setting;
