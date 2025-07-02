const express = require('express');
const router = express.Router();
const Department = require('../models/Department');
const User = require('../models/User'); // Added for dependency check
const Task = require('../models/Task'); // Added for dependency check
const { protect, authorize } = require('../middleware/authMiddleware');

// @route   POST /api/departments
// @desc    Create a new department
// @access  Admin
router.post('/', protect, authorize('Admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Department name is required' });
  }
  try {
    const existingDepartment = await Department.findOne({ name });
    if (existingDepartment) {
      return res.status(400).json({ message: 'Department already exists' });
    }
    const department = new Department({ name });
    await department.save();
    res.status(201).json(department);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/departments
// @desc    Get all departments
// @access  Authenticated Users (for dropdowns, etc.)
router.get('/', protect, async (req, res) => {
  try {
    const departments = await Department.find().sort({ name: 1 });
    res.json(departments);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/departments/:id
// @desc    Get department by ID
// @access  Authenticated Users
router.get('/:id', protect, async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    res.json(department);
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Department not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/departments/:id
// @desc    Update a department
// @access  Admin
router.put('/:id', protect, authorize('Admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Department name is required' });
  }
  try {
    let department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    // Check if new name conflicts with an existing department (excluding itself)
    const existingDepartment = await Department.findOne({ name: name, _id: { $ne: req.params.id } });
    if (existingDepartment) {
        return res.status(400).json({ message: `Department name '${name}' already exists.` });
    }

    department.name = name;
    await department.save();
    res.json(department);
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Department not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/departments/:id
// @desc    Delete a department
// @access  Admin
router.delete('/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    // Check if department is used by any User
    const userDependency = await User.findOne({ department: req.params.id });
    if (userDependency) {
      return res.status(400).json({ message: 'Cannot delete department. It is assigned to one or more users.' });
    }

    // Check if department is used by any Task
    const taskDependency = await Task.findOne({ responsibleDepartmentIds: req.params.id });
    if (taskDependency) {
      return res.status(400).json({ message: 'Cannot delete department. It is responsible for one or more tasks.' });
    }

    await department.deleteOne();
    res.json({ message: 'Department removed successfully' });
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Department not found' });
    }
    res.status(500).send('Server error');
  }
});

module.exports = router;
