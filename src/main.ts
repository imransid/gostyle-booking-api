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
    .addBearerAuth()
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
