const jwt = require('jsonwebtoken');

const generateToken = (user) => {
  return jwt.sign({
    id: user._id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    department: user.department // Ensure 'user' object has these fields when token is generated
  }, process.env.JWT_SECRET, {
    expiresIn: '30d', // Token expires in 30 days
  });
};

module.exports = generateToken;
