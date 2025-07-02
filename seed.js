require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Department = require('./models/Department');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected for Seeding...');
  } catch (err) {
    console.error(`DB Connection Error: ${err.message}`);
    process.exit(1);
  }
};

const importData = async () => {
  try {
    // Clear existing data to prevent duplicates on re-run
    await User.deleteMany({ username: 'admin' });
    await Department.deleteMany({ name: 'Administration' });

    // 1. Create a default department
    const adminDepartment = await Department.create({
      name: 'Administration',
    });
    console.log('Default department created.');

    // 2. Create a default admin user
    const adminUser = {
      username: 'admin',
      email: 'admin@example.com',
      password: 'password123', // User should change this after first login
      firstName: 'Admin',
      lastName: 'User',
      role: 'Admin',
      department: adminDepartment._id,
    };

    await User.create(adminUser);

    console.log('Admin user created successfully!');
    console.log('---------------------------------');
    console.log('Username: admin');
    console.log('Password: password123');
    console.log('---------------------------------');
    process.exit();
  } catch (error) {
    console.error(`Error with data import: ${error.message}`);
    process.exit(1);
  }
};

const destroyData = async () => {
  try {
    await User.deleteMany({ username: 'admin' });
    await Department.deleteMany({ name: 'Administration' });
    console.log('Default admin user and department destroyed.');
    process.exit();
  } catch (error) {
    console.error(`Error with data destruction: ${error}`);
    process.exit(1);
  }
};

const run = async () => {
    await connectDB();

    if (process.argv[2] === '-d') {
        await destroyData();
    } else {
        await importData();
    }
}

run();
