import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { Identity } from './auth.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Identity => {
    return context.switchToHttp().getRequest().user;
  },
);
