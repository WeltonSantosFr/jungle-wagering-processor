import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { StructuredJsonLogger } from './infrastructure/observability/json-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredJsonLogger(),
  });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
