We have finalized the technical infrastructure and production deployment direction for this project.

FINAL TECHNICAL INFRASTRUCTURE PLAN

1. Development

For now, development will continue in Replit.

Replit is our development/build environment.

The production system should NOT depend on Replit.

The Backend API will remain its own separate Replit project during development.

The future applications will also be separate projects:

- Backend API
- Users App
- Admin Panel
- Host Panel
- Manager Panel
- Support Panel

---

2. Production Backend Server

When we move to production, the Backend API will run on AWS EC2.

EC2 will run our Node.js/TypeScript backend server.

The backend will remain a modular monolithic application initially.

We are NOT starting with microservices.

The architecture should allow us to add multiple EC2 backend instances later if traffic requires horizontal scaling.

---

3. Production Database

Use Amazon RDS for PostgreSQL as the production database.

The application server on EC2 will connect to RDS PostgreSQL through the private AWS network where practical.

PostgreSQL remains the authoritative source of truth for persistent application/business data.

Do not put the production database on the EC2 server itself.

This separation is intentional because database reliability, backups, scaling and maintenance should be independent from the application server.

---

4. Production File / Screenshot Storage

Competition screenshots and other uploaded files should be stored in Amazon S3, not inside PostgreSQL and not permanently on the EC2 local filesystem.

PostgreSQL stores the relevant metadata/object key/reference.

S3 stores the actual file.

The architecture should support secure access and controlled file retrieval.

Do not make the system dependent on local EC2 storage for persistent uploaded files.

---

5. Domain / HTTPS

Production APIs should be served through our proper domain/subdomain using HTTPS.

The architecture should support:

Client Apps
→ HTTPS
→ AWS load balancing/reverse proxy layer
→ EC2 Backend API
→ RDS PostgreSQL / S3 / other services

Do not expose internal services unnecessarily.

---

6. Scaling

We are planning for potentially very fast growth.

There is a possibility of reaching approximately:

100,000–500,000 users within 1–2 months.

Therefore the architecture must be designed for scaling from the beginning.

Initial production:

AWS EC2 + RDS PostgreSQL + S3

As traffic grows, we should be able to move toward:

Load Balancer → Multiple EC2 backend instances

without rewriting the application.

Do not introduce Kubernetes/microservices unless actual scale requires them.

---

7. Database scaling

RDS PostgreSQL should be configured appropriately for the expected workload.

The backend must use:

- connection pooling
- proper indexes
- efficient queries
- pagination
- transaction management
- row-level locking where required
- constraints
- query optimization

If traffic becomes significantly larger, we can later consider:

- larger RDS instance
- read replicas
- additional caching
- database optimization/partitioning where justified

Do not add these prematurely.

---

8. Caching / Redis

We do NOT want unnecessary infrastructure at the beginning.

If actual workload shows that caching or distributed coordination is required, we can introduce Amazon ElastiCache/Redis later.

Potential uses could include:

- caching read-heavy configuration
- distributed rate limiting
- distributed locks where appropriate
- temporary data
- scaling coordination

But PostgreSQL remains the authoritative source for financial and business state.

Do not move wallet balances, transaction truth or contest state into Redis.

---

9. Background Jobs / Scheduler

The backend already has a scheduler concept.

Production scheduled jobs must work correctly even if:

- EC2 restarts
- the application crashes
- multiple EC2 instances are running
- a job executes more than once

Therefore jobs must be idempotent and database-backed.

Do not rely on a single EC2 server's in-memory timers for critical business operations.

If the system later requires a dedicated job/queue infrastructure, we can introduce it separately.

---

10. Notifications

The application will use push notifications.

The backend will trigger push notifications for the events already documented in the project.

Notification delivery should be asynchronous and retry-safe.

A notification failure must NOT roll back or break critical operations such as:

- contest joining
- wallet transactions
- result processing
- prize distribution

We are not building a permanent notification-history/archive system unless already required by the existing product documentation.

---

11. WebSockets / Polling

We are NOT going to use WebSockets everywhere.

Normal data:

Client → REST API → Backend

For information that genuinely requires live updates, we can use the appropriate mechanism:

- WebSockets where true real-time communication is required
- polling where occasional updates are sufficient
- push notifications for user/device notifications

Choose the simplest reliable mechanism for each actual requirement.

Do not add real-time infrastructure without a real product need.

---

12. Payment infrastructure

PayU remains our payment provider for:

- deposits
- withdrawals/payouts

Payment processing must remain server-side.

PayU callbacks/webhooks must be verified and processed idempotently.

Financial state is stored in PostgreSQL.

Do not trust client-side payment status.

---

13. Security

Production infrastructure should include:

- HTTPS
- secure environment secrets
- AWS security groups
- restricted database access
- authentication/authorization
- API rate limiting
- input validation
- secure file upload validation
- payment callback verification
- proper access control
- no secrets in source code
- no sensitive credentials in logs

RDS should not be publicly exposed unless there is a specific unavoidable reason.

---

14. Backups & Recovery

Production PostgreSQL should use RDS backups and point-in-time recovery where appropriate.

S3 should be configured so that important uploaded files are not accidentally lost.

The architecture should consider:

- database backups
- recovery
- file durability
- server replacement
- EC2 restart/replacement

The application must be recoverable without depending on a particular EC2 machine's local filesystem.

---

15. Logging & Monitoring

Production should have proper monitoring for:

- EC2 health
- application errors
- API latency
- database health
- CPU/memory usage
- disk usage
- scheduler failures
- payment failures
- important business errors

AWS CloudWatch can be used for infrastructure/application monitoring where appropriate.

---

16. Final Production Architecture

The intended initial production architecture is:

Users App
Admin Panel
Host Panel
Manager Panel
Support Panel

↓

HTTPS / Domain

↓

AWS Load Balancer / Reverse Proxy layer

↓

AWS EC2 — Backend API

↓

Amazon RDS PostgreSQL

and

Amazon S3 — Screenshots / uploaded files

Optional infrastructure added only when actually needed:

Redis / ElastiCache
Queue/worker infrastructure
Additional EC2 instances
Read replicas
etc.

---

17. Important principle

Do not over-engineer the first production deployment.

Our initial target is:

AWS EC2 + RDS PostgreSQL + S3 + Push Notifications + existing Backend Scheduler

with clean architecture that can later scale horizontally.

The application must be:

Reliable → Secure → Performant → Scalable

without introducing unnecessary services.

Please treat this as the finalized technical infrastructure direction and keep the implementation consistent with it.

Before implementing infrastructure-specific changes, audit the current backend and identify exactly what needs to change to make the existing code compatible with this production architecture.