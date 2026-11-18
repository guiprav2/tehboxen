# Chat objects

Implemented in `other/chats.js` + VFS `link()` / `append()` in `other/vfs.js`.

Canonical store (one thread, many views):

```
var/chats/<chatId>/
  meta.yaml        # participants, app, kind: dm|group, title? (groups)
  messages.yaml    # APPEND-ONLY event stream (messages + receipts)
  files/
```

## DMs (1:1)

```
home/bambi/.relay/tyler/messages.yaml  → same inode as var/chats/<id>/messages.yaml
home/tyler/.relay/bambi/messages.yaml  → same inode

home/tyler/.relay/avatar.jpg           → subject avatar (often hardlink of ~/Pictures/portrait.jpg)
home/bambi/.relay/tyler/avatar.jpg     → hardlink to tyler's avatar (0644; write-through on inode)
```

Helpers: `createChat`, `addContact`, `linkPeerAvatar`, `syncUserPortraitAvatar`, `migratePhoneChat`.

See AGENTS.md **character pictures** for portrait/avatar layout and hardlink rules.

## Groups (occasional, created on demand)

```
var/chats/<chatId>/meta.yaml
  kind: group
  title: "Park 👀"
  participants: [bambi, sam, tyler]
  createdBy: tyler

home/<user>/.relay/g-<chatId>/
  profile.yaml   # kind: group, name/title, participants (projection)
  messages.yaml  → hardlink to canonical
  files/
```

Helpers: `createGroup`, `addToGroup`, `removeFromGroup`, `renameGroup`, `getChat`, `listChatsFor`.
View id helpers: `groupViewId`, `isGroupViewId`, `chatIdFromGroupViewId`.

Groups need ≥3 participants including `createdBy`. They are not permanent X+Y+Z fixtures — create when a scene needs a shared thread.

## messages.yaml — append-only event stream

**Never rewrite or patch `messages.yaml` after it exists.** Create once (empty list or seed), then only `vfs.append` / `appendYamlItem` / `appendMessage` / `appendReceipt`.

Each array item is an event:

```yaml
- type: message          # optional; implied if `from` / `text` / `files` present
  id: m1
  from: bambi            # username — never me/them
  time: ISO-8601
  text: …
  files: [photo.jpg]

- type: receipt          # read receipt — same file, still append-only
  msg: m1
  by: tyler
  at: ISO-8601
```

Readers fold the stream (`foldMessageEvents`): message events become chat rows; receipt events mark who has read which `msg` id. Legacy per-user `bambi_read:` flags on message objects are still honored if present, but new code must append receipt events instead of mutating old items.

Same-tab appends are serialized per inode in `vfs.append`. Do not use `vfs.write` / `writeYaml` / full-array dumps on an existing messages.yaml (agents, reply.py, dbg, life loop — all of them).

Shell helpers: `python3 /tmp/tehboxen-wa/reply.py` → `append_them` → `vfs.append`.

Shell: `addcontact <user> [--app relay]`, `ln` / `ln -sF`.
Migrate legacy phone folders: `migratePhoneChat(phone)` from `other/chats.js`.
