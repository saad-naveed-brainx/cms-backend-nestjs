# Demo clients

Two made-up clients for the pitch (D-044): **Kettle & Crumb**, a bakery café, and **Studio Halden**, an
architecture studio. Each folder is one client: `content.json` (its site, look, content type and pages)
and `images/` (its pictures and logo). Nothing about them is in the code.

```bash
npm run demo -- --email admin@demo.test                    # on this computer: <address>.localhost
npm run demo -- --email you@example.com --domain example.com   # live: <address>.example.com
npm run demo -- --email admin@demo.test --replace          # delete and make them again
```

- The sites belong to the account given with `--email`, which owns both organisations: one sign-in
  shows both in the Site switcher. A new account gets `SEED_ADMIN_PASSWORD`, or a generated password
  shown once.
- In blocks, `"picture:shop.jpg"` is replaced with that picture's address in the media library.
- After `--replace`, a running API may answer the old site for up to a minute (its address memory).

## Pictures

Free photos from [Unsplash](https://unsplash.com) under the [Unsplash Licence](https://unsplash.com/license)
(free to use, commercial use included, no permission needed), downloaded at 1600 px. The logos were
drawn for this demo.

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
