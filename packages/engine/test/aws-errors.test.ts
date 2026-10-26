import { describe, expect, it } from 'vitest';
import { awsErrorType } from '../src/translate.js';

/**
 * The error type an AWS client reads from `x-amzn-errortype`, one table for the sidecar's own answers
 * and a takeover's (the sidecar had a copy of its own that named a 401 differently).
 */
describe('the AWS error type for a status', () => {
  it('names an unknown key and a refused caller apart, and the rest as Bedrock does', () => {
    expect(awsErrorType(401)).toBe('UnrecognizedClientException');
    expect(awsErrorType(403)).toBe('AccessDeniedException');
    const named = [400, 404, 408, 409, 424, 429, 500, 503].map((status) => [status, awsErrorType(status)]);
    expect(named).toEqual([
      [400, 'ValidationException'],
      [404, 'ResourceNotFoundException'],
      [408, 'ModelTimeoutException'],
      [409, 'ConflictException'],
      [424, 'ModelErrorException'],
      [429, 'ThrottlingException'],
      [500, 'InternalServerException'],
      [503, 'ServiceUnavailableException'],
    ]);
  });

  it('falls back by class: a client error as a ValidationException, a server error as an InternalServerException', () => {
    expect(awsErrorType(418)).toBe('ValidationException');
    expect(awsErrorType(502)).toBe('InternalServerException');
    expect(awsErrorType(529)).toBe('InternalServerException');
  });
});
