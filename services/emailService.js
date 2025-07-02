const nodemailer = require('nodemailer');
const User = require('../models/User'); // To fetch user emails
const Department = require('../models/Department'); // To fetch department details

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  // secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
});

const sendEmail = async (to, subject, htmlContent) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: to, // can be a single email string or comma-separated string for multiple recipients
      subject: subject,
      html: htmlContent,
    });
    console.log('Email sent successfully to:', to);
  } catch (error) {
    console.error('Error sending email:', error);
    // In a real app, you might want to queue this email for retry or log more details
  }
};

// --- Notification Email Functions ---

// 1. New Task Assignment
exports.notifyNewTaskAssignment = async (task, season) => {
  if (!task || !season || !task.responsibleDepartments || task.responsibleDepartments.length === 0) return;

  try {
    const usersToNotify = await User.find({
      department: { $in: task.responsibleDepartments },
      emailNotificationsEnabled: true
    }).select('email firstName');

    if (usersToNotify.length === 0) return;

    const responsibleDeptNames = (await Department.find({ _id: { $in: task.responsibleDepartments } }).select('name'))
                                   .map(d => d.name).join(', ');

    for (const user of usersToNotify) {
      const subject = `[New Task Assigned] ${task.taskName} for ${season.seasonName}`;
      const emailBody = `
        <p>Hi ${user.firstName || 'User'},</p>
        <p>A new task has been assigned to your department (${responsibleDeptNames}):</p>
        <ul>
          <li><strong>Task:</strong> ${task.taskName} (Sequence: ${task.orderSequence})</li>
          <li><strong>Season:</strong> ${season.seasonName}</li>
          <li><strong>Target Start Date:</strong> ${task.targetStartDate ? new Date(task.targetStartDate).toLocaleDateString() : 'N/A'}</li>
          <li><strong>Target End Date:</strong> ${task.targetEndDate ? new Date(task.targetEndDate).toLocaleDateString() : 'N/A'}</li>
        </ul>
        <p>Please login to the Production Timeline system to view and manage your tasks.</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://10.0.1.249:3005'}/tasks/${task._id}">View Task Details</a></p>
      `;
      await sendEmail(user.email, subject, emailBody);
    }
  } catch (error) {
    console.error('Error in notifyNewTaskAssignment:', error);
  }
};

// 2. Preceding Task Completed
exports.notifyPrecedingTaskCompleted = async (nextTask, completedTask, season) => {
  if (!nextTask || !completedTask || !season || !nextTask.responsibleDepartments || nextTask.responsibleDepartments.length === 0) return;

  try {
    const usersToNotify = await User.find({
      department: { $in: nextTask.responsibleDepartments },
      emailNotificationsEnabled: true
    }).select('email firstName');

    if (usersToNotify.length === 0) return;

    const responsibleDeptNames = (await Department.find({ _id: { $in: nextTask.responsibleDepartments } }).select('name'))
                                   .map(d => d.name).join(', ');

    for (const user of usersToNotify) {
      const subject = `[Task Ready] ${nextTask.taskName} for ${season.seasonName}`;
      const emailBody = `
        <p>Hi ${user.firstName || 'User'},</p>
        <p>The preceding task, '${completedTask.taskName}' (Sequence: ${completedTask.orderSequence}), has been completed.</p>
        <p>Your task, '${nextTask.taskName}' (Sequence: ${nextTask.orderSequence}), for season '${season.seasonName}' is now ready to be worked on.</p>
        <ul>
          <li><strong>Task:</strong> ${nextTask.taskName}</li>
          <li><strong>Season:</strong> ${season.seasonName}</li>
          <li><strong>Target Start Date:</strong> ${nextTask.targetStartDate ? new Date(nextTask.targetStartDate).toLocaleDateString() : 'N/A'}</li>
          <li><strong>Target End Date:</strong> ${nextTask.targetEndDate ? new Date(nextTask.targetEndDate).toLocaleDateString() : 'N/A'}</li>
        </ul>
        <p><a href="${process.env.FRONTEND_URL || 'http://10.0.1.249:3005'}/tasks/${nextTask._id}">View Task Details</a></p>
      `;
      await sendEmail(user.email, subject, emailBody);
    }
  } catch (error) {
    console.error('Error in notifyPrecedingTaskCompleted:', error);
  }
};

// 3. Task Blocked
exports.notifyTaskBlocked = async (blockedTask, season, blockingUser) => {
  if (!blockedTask || !season) return;

  try {
    // Notify Admins and Planners
    const adminsAndPlanners = await User.find({
      role: { $in: ['Admin', 'Planner'] },
      emailNotificationsEnabled: true
    }).select('email firstName');

    if (adminsAndPlanners.length === 0) return;

    const blockingUserName = blockingUser ? `${blockingUser.firstName} ${blockingUser.lastName} (${blockingUser.email})` : 'System';

    for (const recipient of adminsAndPlanners) {
      const subject = `[Task Blocked] ${blockedTask.taskName} for ${season.seasonName}`;
      const emailBody = `
        <p>Hi ${recipient.firstName || 'Admin/Planner'},</p>
        <p>The task '${blockedTask.taskName}' (Sequence: ${blockedTask.orderSequence}) for season '${season.seasonName}' has been marked as BLOCKED.</p>
        <ul>
          <li><strong>Task:</strong> ${blockedTask.taskName}</li>
          <li><strong>Season:</strong> ${season.seasonName}</li>
          <li><strong>Status:</strong> ${blockedTask.status}</li>
          <li><strong>Remarks:</strong> ${blockedTask.remarks || 'N/A'}</li>
          <li><strong>Blocked by:</strong> ${blockingUserName}</li>
        </ul>
        <p>Please review the task and take necessary action.</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://10.0.1.249:3005'}/tasks/${blockedTask._id}">View Task Details</a></p>
      `;
      await sendEmail(recipient.email, subject, emailBody);
    }
  } catch (error) {
    console.error('Error in notifyTaskBlocked:', error);
  }
};

module.exports.transporter = transporter; // Export transporter for direct use if needed (e.g. testing connection)
