import { z } from 'zod';

/**
 * A new account's details when accepting a link, for a website's invitation and an organisation's owner
 * link alike: the name trimmed, the password as typed (spaces are part of it).
 */
export const NewAccount = z.object({
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
});
