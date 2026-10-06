export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function errorBody(error) {
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const message =
    error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试。';
  return { error: { code, message } };
}
