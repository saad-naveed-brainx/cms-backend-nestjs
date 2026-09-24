import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global so that repositories can inject PrismaService without re-importing.
 * Direct use of PrismaService outside the repository layer is discouraged —
 * tenant scoping is enforced there (see decision log: "Scoping enforcement").
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
