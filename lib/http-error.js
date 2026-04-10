function httpError(statusCode, message) {
  const err = new Error(message || `HTTP Error ${statusCode}`);
  err.statusCode = statusCode;
  return err;
}

export default httpError;
