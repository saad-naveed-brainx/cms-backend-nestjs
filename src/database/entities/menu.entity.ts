import { Column, Entity, ForeignKey, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Site } from './site.entity.js';

export enum MenuLocation {
  Header = 'header',
  Footer = 'footer',
}

/** A navigation menu. One per location per site (GOV-03). */
@Entity('menus')
@Unique(['siteId', 'location'])
@Unique(['siteId', 'id'])
export class Menu extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('text')
  name: string;

  @Column({ type: 'enum', enum: MenuLocation, enumName: 'menu_location' })
  location: MenuLocation;
}
