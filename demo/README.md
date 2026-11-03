# Demo clients

Two made-up companies for the pitch (D-044), each with two websites (organizations T4): **Kettle & Crumb Ltd**, a
bakery café (the café site and a wholesale site), and **Studio Halden AS**, an architecture studio (the studio site and
a journal). Each folder is one website: `content.json` (its organization, site, look, content type, people and pages)
and `images/` (its pictures and logo). Nothing about them is in the code.

| Folder | Organization | Website |
| ------ | ------------ | ------- |
| `kettle-and-crumb/` | Kettle & Crumb Ltd | Kettle & Crumb |
| `kettle-and-crumb-wholesale/` | Kettle & Crumb Ltd | Kettle & Crumb Wholesale |
| `studio-halden/` | Studio Halden AS | Studio Halden |
| `studio-halden-journal/` | Studio Halden AS | Studio Halden Journal |

```bash
npm run demo -- --email admin@demo.test                    # on this computer: <address>.localhost
npm run demo -- --email you@example.com --domain example.com   # live: <address>.example.com
npm run demo -- --email admin@demo.test --replace          # delete and make them again
```

- The sites belong to the account given with `--email`, which owns both organizations: one sign-in
  shows both, each with its two websites. A new account gets `SEED_ADMIN_PASSWORD`, or a generated password
  shown once.
- Folders are grouped by their `organization`. The first of a group makes the organization (and the account, if it is new);
  the next ones add a website to that same organization. An account already there owns it as before, so a second run
  never makes a second organization of the same name.
- Each client's `people` (an Editor, an Author, a Contributor and a Viewer, on `.test` addresses) join its site through
  the same invitations anyone else uses. A new person's generated password is printed **once**, in that run's output, and
  is kept nowhere else. Someone who already has an account, as everyone does on a `--replace` (it deletes the site, not
  accounts), is added back and keeps their password: the output says `existing account, password unchanged`. The
  `--email` account owns the sites, so it cannot be one of the `people`: that is refused before anything is made.
  A person may be in several files, with a different role on each website: Maya is the bakery's Editor and the
  wholesale site's Viewer, Tom the reverse, and others are on one website only. The first file that names a person
  makes the account; the later ones meet it again.
- A page with `"author": "<a people email>"` is created and published as that person, under their own role's rules, so the
  admin shows them as its author. Only the Editor or the Author can be named, and not on the Home page, which comes with
  the site; anything else is refused before anything is made. Pages with no `author` are the account's.
- In blocks, `"picture:shop.jpg"` is replaced with that picture's address in the media library.
- `--replace` deletes and makes each website again but keeps the organization, and then removes the account's empty
  organizations named like a demo company: what earlier runs left behind, when each run made a new organization. One
  that has a website, or belongs to someone else, is never removed.
- After `--replace`, a running API may answer the old site for up to a minute (its address memory).

## Pictures

Free photos from [Unsplash](https://unsplash.com) under the [Unsplash Licence](https://unsplash.com/license)
(free to use, commercial use included, no permission needed), downloaded at 1600 px. The logos were
drawn for this demo. The two newer websites reuse their sibling's pictures and logo (exact copies, nothing new downloaded):
`kettle-and-crumb-wholesale/images/` has `shop.jpg`, `sourdough.jpg`, `croissants.jpg` and `logo.png` of
`kettle-and-crumb/`, and `studio-halden-journal/images/` has `concrete.jpg`, `courtyard.jpg`, `model.jpg` and `logo.png`
of `studio-halden/`.

| File | Source |
| ---- | ------ |
| `kettle-and-crumb/images/shop.jpg` | https://images.unsplash.com/photo-1587241321921-91a834d6d191 |
| `kettle-and-crumb/images/sourdough.jpg` | https://images.unsplash.com/photo-1590301157172-7ba48dd1c2b2 |
| `kettle-and-crumb/images/croissants.jpg` | https://images.unsplash.com/photo-1623334044303-241021148842 |
| `kettle-and-crumb/images/cafe.jpg` | https://images.unsplash.com/photo-1606626367155-5d23349572ce |
| `kettle-and-crumb/images/coffee.jpg` | https://images.unsplash.com/photo-1541167760496-1628856ab772 |
| `kettle-and-crumb/images/kneading.jpg` | https://images.unsplash.com/photo-1649675602217-416a4fafcecb |
| `kettle-and-crumb/images/pastries.jpg` | https://images.unsplash.com/photo-1483695028939-5bb13f8648b0 |
| `kettle-and-crumb/images/rye.jpg` | https://images.unsplash.com/photo-1597604391235-a7429b4b350c |
| `studio-halden/images/concrete.jpg` | https://images.unsplash.com/photo-1730170787463-53a7074137fa |
| `studio-halden/images/villa.jpg` | https://images.unsplash.com/photo-1670589953882-b94c9cb380f5 |
| `studio-halden/images/forest-house.jpg` | https://images.unsplash.com/photo-1659720879268-818dea77efaa |
| `studio-halden/images/courtyard.jpg` | https://images.unsplash.com/photo-1717477660140-8709f24e2894 |
| `studio-halden/images/facade.jpg` | https://images.unsplash.com/photo-1730170787342-28825e03d9ae |
| `studio-halden/images/stairs.jpg` | https://images.unsplash.com/photo-1601993957728-1e56ab70c5a8 |
| `studio-halden/images/interior.jpg` | https://images.unsplash.com/photo-1567016376408-0226e4d0c1ea |
| `studio-halden/images/model.jpg` | https://images.unsplash.com/photo-1631454965644-00510875561f |
