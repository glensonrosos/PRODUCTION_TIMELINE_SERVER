const express = require('express');
const router = express.Router();
const Buyer = require('../models/Buyer');
const Season = require('../models/Season'); // Added for dependency check
const { protect, authorize } = require('../middleware/authMiddleware');

// @route   POST /api/buyers
// @desc    Create a new buyer
// @access  Admin
router.post('/', protect, authorize('Admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Buyer name is required' });
  }
  try {
    const existingBuyer = await Buyer.findOne({ name });
    if (existingBuyer) {
      return res.status(400).json({ message: 'Buyer already exists' });
    }
    const buyer = new Buyer({ name });
    await buyer.save();
    res.status(201).json(buyer);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/buyers
// @desc    Get all buyers
// @access  Authenticated Users
router.get('/', protect, async (req, res) => {
  try {
    const buyers = await Buyer.find().sort({ name: 1 });
    res.json(buyers);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/buyers/:id
// @desc    Get buyer by ID
// @access  Authenticated Users
router.get('/:id', protect, async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id);
    if (!buyer) {
      return res.status(404).json({ message: 'Buyer not found' });
    }
    res.json(buyer);
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Buyer not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/buyers/:id
// @desc    Update a buyer
// @access  Admin
router.put('/:id', protect, authorize('Admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Buyer name is required' });
  }
  try {
    let buyer = await Buyer.findById(req.params.id);
    if (!buyer) {
      return res.status(404).json({ message: 'Buyer not found' });
    }
    const existingBuyer = await Buyer.findOne({ name: name, _id: { $ne: req.params.id } });
    if (existingBuyer) {
        return res.status(400).json({ message: `Buyer name '${name}' already exists.` });
    }

    buyer.name = name;
    await buyer.save();
    res.json(buyer);
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Buyer not found' });
    }
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/buyers/:id
// @desc    Delete a buyer
// @access  Admin
router.delete('/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id);
    if (!buyer) {
      return res.status(404).json({ message: 'Buyer not found' });
    }
    // Check if buyer is used by any Season
    const seasonDependency = await Season.findOne({ buyer: req.params.id });
    if (seasonDependency) {
      return res.status(400).json({ message: 'Cannot delete buyer. It is associated with one or more seasons.' });
    }

    await buyer.deleteOne();
    res.json({ message: 'Buyer removed successfully' });
  } catch (error) {
    console.error(error.message);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Buyer not found' });
    }
    res.status(500).send('Server error');
  }
});

module.exports = router;
