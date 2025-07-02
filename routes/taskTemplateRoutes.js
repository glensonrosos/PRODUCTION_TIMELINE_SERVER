const express = require('express');
const router = express.Router();
const { TaskTemplate } = require('../models'); // Assuming index.js in models exports TaskTemplate
const { protect, authorize } = require('../middleware/authMiddleware'); // Adjust path if necessary
const SeasonSnapshot = require('../models/SeasonSnapshot');
const mongoose = require('mongoose');

// Helper function to validate alphabetical order of preceding tasks
function validatePrecedingOrderAlphabetical(currentOrder, precedingTasksArray) {
  if (!precedingTasksArray || precedingTasksArray.length === 0) {
    return { isValid: true, invalidTasks: [] };
  }
  const invalidTasks = precedingTasksArray.filter(ptOrder => ptOrder >= currentOrder);
  return {
    isValid: invalidTasks.length === 0,
    invalidTasks
  };
}

// Helper function to detect circular dependencies using a provided map
function hasCircularDependency(orderToCheck, tasksToCheck, path, allTemplatesMap) {
  if (path.includes(orderToCheck)) {
    return true; // Cycle detected
  }

  if (!tasksToCheck || tasksToCheck.length === 0) {
    return false;
  }

  const newPath = [...path, orderToCheck];

  for (const precedingOrder of tasksToCheck) {
    const nextTasks = allTemplatesMap.get(precedingOrder);
    // Only recurse if the preceding task exists in the map and has preceding tasks itself
    if (nextTasks) { // No need to check nextTasks.length > 0 here, base case handles it
      if (hasCircularDependency(precedingOrder, nextTasks, newPath, allTemplatesMap)) {
        return true;
      }
    }
  }
  return false;
}

// @route   POST /api/task-templates
// @desc    Create a new task template
// @access  Admin
router.post('/', protect, authorize(['Admin']), async (req, res) => {
  try {
    const { order, name, defaultResponsible, defaultPrecedingTasks, defaultLeadTime } = req.body;

    // Basic validation
    if (!order || !name || !defaultResponsible || !defaultLeadTime) {
      return res.status(400).json({ message: 'Missing required fields: order, name, defaultResponsible, defaultLeadTime' });
    }

    // Check for existing order code
    const existingTemplate = await TaskTemplate.findOne({ order });
    if (existingTemplate) {
      return res.status(400).json({ message: 'Task template with this order code already exists' });
    }

    // Validate defaultPrecedingTasks: ensure they exist as valid 'order' codes
    // Circular dependency check
    if (defaultPrecedingTasks && defaultPrecedingTasks.length > 0) {
      const allTemplates = await TaskTemplate.find().select('order defaultPrecedingTasks');
      const allTemplatesMap = new Map();
      allTemplates.forEach(t => allTemplatesMap.set(t.order, t.defaultPrecedingTasks || []));
      
      // Add the current template being created to the map for the check
      allTemplatesMap.set(order, defaultPrecedingTasks);

      if (hasCircularDependency(order, defaultPrecedingTasks, [], allTemplatesMap)) {
        return res.status(400).json({ message: 'Circular dependency detected in defaultPrecedingTasks.' });
      }
    }

    // Alphabetical order validation for preceding tasks
    if (defaultPrecedingTasks && defaultPrecedingTasks.length > 0) {
      const orderValidation = validatePrecedingOrderAlphabetical(order, defaultPrecedingTasks);
      if (!orderValidation.isValid) {
        return res.status(400).json({
          message: `Invalid preceding task(s): Preceding task 'order' codes must be alphabetically before the current task 'order' ('${order}'). Invalid: ${orderValidation.invalidTasks.join(', ')}`,
          invalidTasks: orderValidation.invalidTasks
        });
      }
    }

    // Validate defaultPrecedingTasks: ensure they exist as valid 'order' codes
    if (defaultPrecedingTasks && defaultPrecedingTasks.length > 0) {
      const uniquePrecedingTasks = [...new Set(defaultPrecedingTasks)]; // Remove duplicates for efficiency
      const foundTemplates = await TaskTemplate.find({ order: { $in: uniquePrecedingTasks } }).select('order');
      if (foundTemplates.length !== uniquePrecedingTasks.length) {
        const foundOrders = foundTemplates.map(t => t.order);
        const notFoundOrders = uniquePrecedingTasks.filter(orderCode => !foundOrders.includes(orderCode));
        return res.status(400).json({
          message: `Invalid preceding task(s): The following order codes do not exist: ${notFoundOrders.join(', ')}`,
          notFoundOrders
        });
      }
    }

    const newTaskTemplate = new TaskTemplate({
      order,
      name,
      defaultResponsible,
      defaultPrecedingTasks: defaultPrecedingTasks || [],
      defaultLeadTime
    });

    const savedTemplate = await newTaskTemplate.save();
    res.status(201).json(savedTemplate);
  } catch (error) {
    console.error('Error creating task template:', error);
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error while creating task template' });
  }
});

// @route   GET /api/task-templates
// @desc    Get all task templates
// @access  Authenticated Users (Admin, Planner, User - for read-only purposes)
router.get('/', protect, async (req, res) => {
  try {
    const { includeInactive } = req.query;
    let query = {};

    if (includeInactive !== 'true') {
      query.isActive = true;
    }
    // If includeInactive is 'true', the query remains empty, fetching all.

    const templates = await TaskTemplate.find(query).sort({ order: 1 });
    res.json(templates);
  } catch (error) {
    console.error('Error fetching task templates:', error);
    res.status(500).json({ message: 'Server error while fetching task templates' });
  }
});

// @route   GET /api/task-templates/:id
// @desc    Get a single task template by ID
// @access  Authenticated Users
router.get('/:id', protect, async (req, res) => {
  try {
    const template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found' });
    }
    res.json(template);
  } catch (error) {
    console.error('Error fetching task template by ID:', error);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Task template not found (invalid ID format)' });
    }
    res.status(500).json({ message: 'Server error while fetching task template' });
  }
});

// @route   PUT /api/task-templates/:id
// @desc    Update a task template
// @access  Admin
router.put('/:id', protect, authorize(['Admin']), async (req, res) => {
  try {
    const { order, name, defaultResponsible, defaultPrecedingTasks, defaultLeadTime } = req.body;

    let template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found' });
    }

    // Check if order is being changed and if the new order already exists
    if (order && order !== template.order) {
        const existingOrderTemplate = await TaskTemplate.findOne({ order: order, _id: { $ne: template._id } });
        if (existingOrderTemplate) {
            return res.status(400).json({ message: 'Another task template with this order code already exists' });
        }
        template.order = order;
    }

    // Update fields
    if (name) template.name = name;
    if (defaultResponsible) template.defaultResponsible = defaultResponsible;
    // Assignment of defaultPrecedingTasks is now handled above after validation
    if (defaultLeadTime) template.defaultLeadTime = defaultLeadTime;
    if (typeof req.body.isActive === 'boolean') {
      template.isActive = req.body.isActive;
    }
    
    // Circular dependency check for updates
    if (req.body.hasOwnProperty('defaultPrecedingTasks')) { // Check only if field is present
      const newPrecedingTasks = req.body.defaultPrecedingTasks || [];
      const newOrder = req.body.order || template.order;

      if (newPrecedingTasks.length > 0) {
        const allDbTemplates = await TaskTemplate.find().select('order defaultPrecedingTasks _id');
        const hypotheticalTemplatesMap = new Map();

        allDbTemplates.forEach(t => {
          if (t._id.toString() !== template._id.toString()) {
            hypotheticalTemplatesMap.set(t.order, t.defaultPrecedingTasks || []);
          }
        });
        // Add/update the current template with its proposed changes to the hypothetical map
        hypotheticalTemplatesMap.set(newOrder, newPrecedingTasks);
        
        // If the order is changing, ensure the old order entry (if different) is not in the map pointing to old data
        // This is implicitly handled by iterating allDbTemplates and only adding others, then setting the newOrder.
        // If newOrder is same as template.order, it just overwrites with newPrecedingTasks.

        if (hasCircularDependency(newOrder, newPrecedingTasks, [], hypotheticalTemplatesMap)) {
          return res.status(400).json({ message: 'Circular dependency detected in defaultPrecedingTasks.' });
        }
      }
    }

    // Alphabetical order validation for preceding tasks on update
    if (req.body.hasOwnProperty('defaultPrecedingTasks')) {
      const newPrecedingTasks = req.body.defaultPrecedingTasks || [];
      const newOrder = req.body.order || template.order; // Use the potentially updated order
      if (newPrecedingTasks.length > 0) {
        const orderValidation = validatePrecedingOrderAlphabetical(newOrder, newPrecedingTasks);
        if (!orderValidation.isValid) {
          return res.status(400).json({
            message: `Invalid preceding task(s): Preceding task 'order' codes must be alphabetically before the current task 'order' ('${newOrder}'). Invalid: ${orderValidation.invalidTasks.join(', ')}`,
            invalidTasks: orderValidation.invalidTasks
          });
        }
      }
    }

    // Validate defaultPrecedingTasks if provided for update
    if (defaultPrecedingTasks && defaultPrecedingTasks.length > 0) {
      const uniquePrecedingTasks = [...new Set(defaultPrecedingTasks)];
      const foundTemplates = await TaskTemplate.find({ order: { $in: uniquePrecedingTasks } }).select('order');
      if (foundTemplates.length !== uniquePrecedingTasks.length) {
        const foundOrders = foundTemplates.map(t => t.order);
        const notFoundOrders = uniquePrecedingTasks.filter(orderCode => !foundOrders.includes(orderCode));
        return res.status(400).json({
          message: `Invalid preceding task(s): The following order codes do not exist: ${notFoundOrders.join(', ')}`,
          notFoundOrders
        });
      }
      template.defaultPrecedingTasks = defaultPrecedingTasks; // Assign validated tasks
    } else if (defaultPrecedingTasks && defaultPrecedingTasks.length === 0) {
      template.defaultPrecedingTasks = []; // Allow clearing preceding tasks
    } else if (req.body.hasOwnProperty('defaultPrecedingTasks') && !defaultPrecedingTasks) {
      // If 'defaultPrecedingTasks' is explicitly set to null or undefined in the request body
      template.defaultPrecedingTasks = [];
    }


    const updatedTemplate = await template.save();
    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error updating task template:', error);
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Task template not found (invalid ID format)' });
    }
    res.status(500).json({ message: 'Server error while updating task template' });
  }
});

// @route   PATCH /api/task-templates/:id/toggle-active
// @desc    Toggle the active status of a task template
// @access  Admin
router.patch('/:id/toggle-active', protect, authorize(['Admin']), async (req, res) => {
  try {
    const template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found' });
    }

    template.isActive = !template.isActive;
    await template.save();

    res.json(template);
  } catch (error) {
    console.error('Error toggling task template active status:', error);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Task template not found (invalid ID format)' });
    }
    if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error while toggling active status' });
  }
});

// @route   DELETE /api/task-templates/:id
// @desc    Delete a task template
// @access  Admin
router.delete('/:id', protect, authorize(['Admin']), async (req, res) => {
  try {
    const template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found' });
    }

    // Safety Check 1: Ensure the template is not used in any season snapshots.
    const snapshotInUse = await SeasonSnapshot.findOne({ 'tasks.order': template.order });
    if (snapshotInUse) {
      return res.status(400).json({ message: 'Cannot delete this template because it is already used in at least one season. Please deactivate it instead.' });
    }

    // Safety Check 2: Ensure the template is not a dependency for other templates.
    const dependentTemplate = await TaskTemplate.findOne({ defaultPrecedingTasks: template.order });
    if (dependentTemplate) {
      return res.status(400).json({
        message: `Cannot delete this template because it is a preceding task for another template (e.g., '${dependentTemplate.name}'). Please remove the dependency first.`
      });
    }

    await TaskTemplate.deleteOne({ _id: req.params.id });

    res.json({ message: 'Task template deleted successfully' });
  } catch (error) {
    console.error('Error deleting task template:', error);
    if (error.kind === 'ObjectId') {
        return res.status(404).json({ message: 'Task template not found (invalid ID format)' });
    }
    res.status(500).json({ message: 'Server error while deleting task template' });
  }
});

module.exports = router;
