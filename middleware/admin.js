// middleware/admin.js
const { fail } = require('../utils/response');

/**
 * Guard admin-only routes.
 *
 * Must be placed AFTER the `authenticate` middleware so that req.user is set.
 *
 * The JWT payload is checked for `role === 'admin'`.
 * Assign role = 'admin' in your users table and include it in signToken()
 * when the account is an admin account.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return fail(res, 'Unauthorized', 401);
  }

  if (req.user.role !== 'admin') {
    return fail(res, 'Forbidden: Admin access required', 403);
  }

  next();
}

module.exports = { requireAdmin };