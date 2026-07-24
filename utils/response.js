// utils/response.js

/**
 * Send a uniform success envelope.
 * { success: true, message, data }
 */
function ok(res, message, data = null, statusCode = 200) {
  const body = { success: true, message };
  if (data !== null) body.data = data;
  return res.status(statusCode).json(body);
}

/**
 * Send a uniform error envelope.
 * { success: false, message, errors? }
 */
function fail(res, message, statusCode = 400, errors = null) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

module.exports = { ok, fail };
