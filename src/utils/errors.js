'use strict';

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'ERROR';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Factory functions for common error types
const NotFoundError = (msg = 'Resource not found') => new AppError(msg, 404, 'NOT_FOUND');
const ForbiddenError = (msg = 'Access denied') => new AppError(msg, 403, 'FORBIDDEN');
const BadRequestError = (msg = 'Invalid request') => new AppError(msg, 400, 'BAD_REQUEST');
const UnauthorizedError = (msg = 'Unauthorized') => new AppError(msg, 401, 'UNAUTHORIZED');
const ConflictError = (msg = 'Resource conflict') => new AppError(msg, 409, 'CONFLICT');
const GoneError = (msg = 'Resource gone') => new AppError(msg, 410, 'GONE');
const ServiceUnavailableError = (msg = 'Service unavailable') => new AppError(msg, 503, 'SERVICE_UNAVAILABLE');
const RequestTimeoutError = (msg = 'Request timeout') => new AppError(msg, 504, 'REQUEST_TIMEOUT');

module.exports = {
  AppError,
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  UnauthorizedError,
  ConflictError,
  GoneError,
  ServiceUnavailableError,
  RequestTimeoutError,
};
