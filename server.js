// Set timezone for the entire application to ensure date consistency
process.env.TZ = 'Asia/Manila';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Setting = require('./models/Setting');

const app = express();

// Middleware
app.use(cors());
app.use(express.json()); // for parsing application/json
app.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

// Import Routes
const authRoutes = require('./routes/authRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const buyerRoutes = require('./routes/buyerRoutes');
const userRoutes = require('./routes/userRoutes');
const seasonRoutes = require('./routes/seasonRoutes'); // Already added, but good to see context
const taskRoutes = require('./routes/taskRoutes');
const taskTemplateRoutes = require('./routes/taskTemplateRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

// Basic Route
app.get('/', (req, res) => {
  res.send('Production Timeline API is running!');
});

// Mount Routers
app.use('/api/auth', authRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/buyers', buyerRoutes);
app.use('/api/users', userRoutes);
app.use('/api/seasons', seasonRoutes); // Ensure seasonRoutes is mounted before taskRoutes that might be nested
app.use('/api/seasons/:seasonId/tasks', taskRoutes); // For tasks related to a specific season
app.use('/api/tasks', taskRoutes); // For general task operations like GET /api/tasks/:taskId
app.use('/api/task-templates', taskTemplateRoutes);
app.use('/api/settings', settingsRoutes);


// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
.then(() => {
  console.log('MongoDB Connected');
  // Initialize application settings
  Setting.initialize();
})
.catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Global error handler (more specific ones should be in routes or controllers)
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || 'An unexpected error occurred',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }), // Show stack in dev
  });
});

module.exports = app; // For potential testing
