import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AppearanceModule } from './appearance/appearance.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ContentTypesModule } from './content-types/content-types.module.js';
import { ContentModule } from './content/content.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { HostnamesModule } from './hostnames/hostnames.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { PublicModule } from './public/public.module.js';
import { SitesModule } from './sites/sites.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    AppearanceModule,
    HealthModule,
    ContentModule,
    ContentTypesModule,
    PlatformModule,
    ProvisioningModule,
    PublicModule,
    HostnamesModule,
    SitesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
