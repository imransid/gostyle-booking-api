import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody keeps the exact bytes the client sent, alongside the parsed body.
  //
  // Payment webhooks are signed over those bytes. Parsing JSON and
  // re-serialising it changes key order and whitespace, so a signature
  // checked against the re-serialised body NEVER matches. It is the most
  // common way this integration gets quietly broken, and it fails closed:
  // every webhook is rejected as forged.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Every route is /v1/*, except the health probe.
  //
  // The version belongs in the path because it is the only place a client
  // cannot forget to send it: a header default is one misconfigured proxy
  // away from routing v2 traffic at v1 handlers. /health stays where it is
  // because Docker Swarm's healthcheck already points at it, and a probe
  // that 404s takes the service out of rotation on deploy.
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  // Validation lives at the edge, so the handler and the domain never see
  // a malformed value. transform:true is what makes @Transform run and turns
  // "840" into the number 840.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Go Style Booking API')
    .setDescription(
      'The availability engine. A slot is only real when the server says so: ' +
        'availability is computed from staff time and chair capacity, never stored.',
    )
    .setVersion('0.1.0')
    .addTag('availability', 'Which start times the salon can actually deliver')
    // DEFINES the scheme: this is what draws the Authorize button.
    .addBearerAuth()
    /**
     * APPLIES it to every operation. Without this line the button appears,
     * accepts a token, stores it -- and attaches it to nothing, because
     * Swagger UI only sends a credential to operations that declare they
     * want one. Every lock icon stays open and every call comes back
     * "Missing bearer token" while a copy of the same request through curl
     * works, which is a maddening thing to debug.
     *
     * Global rather than @ApiBearerAuth() on seventeen controllers, because
     * the guard is global too: BookingAuthGuard is the APP_GUARD and is
     * closed by default. A new controller is protected the moment it is
     * written, so it should be documented as protected the moment it is
     * written. Per-controller decorators would let the two drift apart, and
     * the drift is invisible until someone opens /docs.
     *
     * @Public() carries the matching opt-out, so the two stay in step from
     * one decorator. swagger-security.spec.ts asserts they never diverge.
     */
    .addSecurityRequirements('bearer')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`API      http://localhost:${port}`);
  console.log(`Swagger  http://localhost:${port}/docs`);
}
void bootstrap();
