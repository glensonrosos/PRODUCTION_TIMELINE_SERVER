const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Department = require('../models/Department'); // Needed for department validation
const generateToken = require('../utils/generateToken');
const { protect, authorize } = require('../middleware/authMiddleware');

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Admin
router.post('/register', protect, authorize(['Admin']), async (req, res) => {
  const {
    username,
    password,
    firstName,
    lastName,
    email,
    department, // Expecting department ID
    role
  } = req.body;

  try {
    // Check if user already exists
    let user = await User.findOne({ $or: [{ email }, { username }] });
    if (user) {
      return res.status(400).json({ message: 'User already exists with this email or username' });
    }

    // Validate department
    const departmentExists = await Department.findById(department);
    if (!departmentExists) {
        return res.status(400).json({ message: 'Invalid Department ID' });
    }

    // Helper function to capitalize names
    const capitalizeName = (name) => {
      if (!name) return '';
      return name.trim().toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    };

    // Create new user
    user = new User({
      username,
      password, // Hashing is handled by pre-save hook in User model
      firstName: capitalizeName(firstName),
      lastName: capitalizeName(lastName),
      email,
      department: department,
      role: role || 'User' // Default to 'User' if not provided
    });

    await user.save();

    res.status(201).json({
      _id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      department: user.department,
      role: user.role,
      token: generateToken(user),
    });

  } catch (error) {
    console.error('Registration error:', error.message);
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).send('Server error');
  }
});

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', async (req, res) => {
  const { usernameOrEmail, password } = req.body;

  try {
    // Check if user exists by username (case-insensitive) or email (typically case-insensitive by DB)
    const user = await User.findOne({
      $or: [
        { username: { $regex: new RegExp(`^${usernameOrEmail}$`, 'i') } }, 
        { email: { $regex: new RegExp(`^${usernameOrEmail}$`, 'i') } } // Also make email explicitly case-insensitive for safety
      ]
    }).populate('department', 'name'); // Populate department name

    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({ message: 'Your account is inactive. Please contact an administrator.' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    res.json({
      _id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      department: user.department, // This will be populated with { _id, name }
      role: user.role,
      emailNotificationsEnabled: user.emailNotificationsEnabled,
      token: generateToken(user),
    });

  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).send('Server error');
  }
});

// @route   POST /api/auth/change-password
// @desc    Change user password
// @access  Private (Authenticated Users)
router.post('/change-password', protect, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id; // Assuming 'protect' middleware adds user object to req

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Please provide current and new passwords.' });
  }

  // Basic validation for new password length (align with frontend and User model schema if any)
  if (newPassword.length < 6) { 
    return res.status(400).json({ message: 'New password must be at least 6 characters long.' });
  }

  try {
    const user = await User.findById(userId);

    if (!user) {
      // This case should ideally not happen if protect middleware is working correctly
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if current password is correct
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Incorrect current password.' });
    }

    // Set new password (hashing should be handled by pre-save hook in User model)
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully.' });

  } catch (error) {
    console.error('Change password error:', error.message);
    if (error.name === 'ValidationError') { // Catch Mongoose validation errors
        return res.status(400).json({ message: error.message });
    }
    res.status(500).send('Server error');
  }
});

module.exports = router;
