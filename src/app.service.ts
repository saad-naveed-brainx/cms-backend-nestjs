import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getServiceInfo(): { service: string; version: string } {
    return { service: 'cms-api', version: '0.1.0' };
  }
}
