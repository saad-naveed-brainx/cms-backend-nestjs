import { Content } from './content.entity.js';
import { ContentType } from './content-type.entity.js';
import { FormSubmission } from './form-submission.entity.js';
import { Hostname } from './hostname.entity.js';
import { Media } from './media.entity.js';
import { Menu } from './menu.entity.js';
import { MenuItem } from './menu-item.entity.js';
import { Organization } from './organization.entity.js';
import { Redirect } from './redirect.entity.js';
import { Revision } from './revision.entity.js';
import { Role } from './role.entity.js';
import { Site } from './site.entity.js';
import { SiteMember } from './site-member.entity.js';
import { Term } from './term.entity.js';
import { TermContent } from './term-content.entity.js';
import { User } from './user.entity.js';

export {
  Content,
  ContentType,
  FormSubmission,
  Hostname,
  Media,
  Menu,
  MenuItem,
  Organization,
  Redirect,
  Revision,
  Role,
  Site,
  SiteMember,
  Term,
  TermContent,
  User,
};

/** Every entity, listed explicitly rather than globbed, so a missing one is a visible omission. */
export const ENTITIES = [
  User,
  Organization,
  Site,
  Hostname,
  Role,
  SiteMember,
  ContentType,
  Content,
  Media,
  Revision,
  Term,
  TermContent,
  Menu,
  MenuItem,
  Redirect,
  FormSubmission,
];
