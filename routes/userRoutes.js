const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Department = require('../models/Department');
const { protect, authorize } = require('../middleware/authMiddleware');

// @route   GET /api/users/profile
// @desc    Get current logged-in user's profile
// @access  Private (Authenticated users)
router.get('/profile', protect, async (req, res) => {
  try {
    // req.user is attached by the 'protect' middleware
    const user = await User.findById(req.user.id).select('-password').populate('department', 'name');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Get profile error:', error.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT /api/users/profile/notifications
// @desc    Update current user's email notification preference
// @access  Private (Authenticated users)
router.put('/profile/notifications', protect, async (req, res) => {
    const { emailNotificationsEnabled } = req.body;

    if (typeof emailNotificationsEnabled !== 'boolean') {
        return res.status(400).json({ message: 'Invalid value for emailNotificationsEnabled. Must be true or false.' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.emailNotificationsEnabled = emailNotificationsEnabled;
        await user.save();

        res.json({ 
            message: 'Notification preference updated successfully.', 
            emailNotificationsEnabled: user.emailNotificationsEnabled 
        });
    } catch (error) {
        console.error('Update notification preference error:', error.message);
        res.status(500).send('Server Error');
    }
});

// --- Admin Routes ---

// @route   GET /api/users
// @desc    Get all users
// @access  Admin
router.get('/', protect, authorize('Admin'), async (req, res) => {
  try {
    const users = await User.find().select('-password').populate('department', 'name').sort({ lastName: 1, firstName: 1 });
    res.json(users);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Admin
router.get('/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password').populate('department', 'name');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'User not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/users/:id
// @desc    Update user (Admin only - for role, department, basic info)
// @access  Admin
router.put('/:id', protect, authorize('Admin'), async (req, res) => {
  const { firstName, lastName, email, departmentId, role, username, isActive } = req.body;

  // Log the received isActive status for debugging
  console.log(`Backend received update for user ${req.params.id}, isActive:`, isActive, `(type: ${typeof isActive})`);

  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check for unique email and username if changed
    if (email && email !== user.email) {
        const existingEmail = await User.findOne({ email: email, _id: { $ne: user._id } });
        if (existingEmail) return res.status(400).json({ message: 'Email already in use by another account.' });
        user.email = email;
    }
    if (username && username !== user.username) {
        const existingUsername = await User.findOne({ username: username, _id: { $ne: user._id } });
        if (existingUsername) return res.status(400).json({ message: 'Username already taken.' });
        user.username = username;
    }

    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (role) user.role = role; // Add validation for allowed roles if necessary

    // Update isActive status if provided and is a boolean
    if (typeof isActive === 'boolean') {
        user.isActive = isActive;
    }

    if (departmentId) {
        const departmentExists = await Department.findById(departmentId);
        if (!departmentExists) {
            return res.status(400).json({ message: 'Invalid Department ID' });
        }
        user.department = departmentId;
    }

    // Note: Password changes are not handled here for security. 
    // Admins should typically trigger a password reset flow for users.

    const updatedUser = await user.save();
    const userToReturn = updatedUser.toObject();
    delete userToReturn.password; // Ensure password is not returned
    
    // Repopulate department if it was changed by ID
    await User.populate(userToReturn, { path: 'department', select: 'name' });

    res.json(userToReturn);

  } catch (error) {
    console.error('Admin update user error:', error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'User or Department not found' });
    }
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete a user (Admin only)
// @access  Admin
router.delete('/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent admin from deleting themselves (optional safeguard)
    if (req.user.id === user.id.toString()) {
        return res.status(400).json({ message: 'Admin cannot delete their own account.'});
    }

    // Instead of deleting, deactivate the user
    user.isActive = false;
    await user.save();
    res.json({ message: 'User deactivated successfully' });

  } catch (error) {
    console.error('Admin delete user error:', error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'User not found' });
    }
    res.status(500).send('Server error');
  }
});

module.exports = router;
