import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import {
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../domain/errors/domain.errors';
import { ResourceConflictError, ResourceNotFoundError } from '../../../application/use-cases/app-utils';

@Catch(DomainError, Error)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_ERROR';
    let message = exception.message;

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidTransactionStateError
    ) {
      status = HttpStatus.BAD_REQUEST;
      errorCode = 'INVALID_PAYLOAD_OR_STATE';
    } else if (exception instanceof InsufficientFundsError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errorCode = exception.failureCode;
    } else if (exception instanceof IdempotencyConflictError) {
      status = HttpStatus.CONFLICT;
      errorCode = 'IDEMPOTENCY_CONFLICT';
    } else if (exception instanceof ResourceConflictError) {
      status = HttpStatus.CONFLICT;
      errorCode = exception.code;
    } else if (exception instanceof ResourceNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      errorCode = 'RESOURCE_NOT_FOUND';
    } else if (exception instanceof DomainError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errorCode = exception.code;
    } else {
      this.logger.error('Unhandled internal server error', exception.stack);
    }

    response.status(status).json({
      statusCode: status,
      errorCode,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}