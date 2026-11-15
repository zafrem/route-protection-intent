# Route inventory

5 route(s), 6 entries: 2 public, 4 authenticated, 0 internal, 0 without a recorded decision; 4 confirmed by a person; 1 with gaps

| ROUTE | METHOD | EXPOSURE | GATE | VIA | DECIDED BY | AUTH CHECK | GAPS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin/users` | GET | authenticated | - | - | user | yes | - |
| `/api/exports` | GET | authenticated | - | - | heuristic | no | protected-no-auth-check |
| `/api/health` | GET | public | - | - | user | no | - |
| `/api/orders` | GET | authenticated | - | - | user | yes | - |
| `/api/orders` | POST | authenticated | - | - | user | yes | - |
| `/blog` | GET | public | - | - | heuristic | no | - |

