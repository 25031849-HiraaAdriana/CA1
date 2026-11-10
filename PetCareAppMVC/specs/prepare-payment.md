Feature: Prepare payment details

User goal:

As a pet owner, I want to prepare payment for a pet service by reviewing the selected service and its amount before proceeding.

Scope:

Provide service details (ID, name, price) from the server catalogue only.

Do not accept client‑supplied payment amounts.

No login required for this classroom mock.

Out of scope: charging money, gateway integration, transactions, new database tables, EJS pages, or changes to existing features.

Request:

GET /payments/prepare/:serviceId

Service catalogue (fixed values):

1, Vaccination, 35

2, Pet Grooming, 50

3, Boarding, 80

Successful response:

HTTP 200 with exactly five JSON fields:

serviceId (number)

serviceName (string)

amount (number)

currency (string, fixed "sgd")

status (string, fixed "READY_FOR_PAYMENT")

Unsuccessful response:

Unknown service: HTTP 404 with {"error":"Service not found"}

Invalid input (non‑numeric or malformed serviceId, e.g., /abc): HTTP 400 with {"error":"Invalid serviceId"}

Acceptance criteria:

AC1: /1 → 200; Vaccination; amount 35; serviceId 1.

AC2: /2 → 200; Pet Grooming; amount 50; serviceId 2.

AC3: /3 → 200; Boarding; amount 80; serviceId 3.

AC4: /999 → 404; exact error object above.

AC5: Each success has exactly five fields, correct types, catalogue values, "sgd", and "READY_FOR_PAYMENT".

AC6: Invalid serviceId format (e.g., /abc) → 400; exact error object above.

Non‑functional requirements:

Endpoint must be idempotent (same request → same response).

Response time should be minimal (simple lookup).

Service names are case‑consistent with catalogue values.

Open questions:

Should invalid HTTP methods (e.g., POST to /prepare/:id) return 405 Method Not Allowed?

Should catalogue be hardcoded in memory or loaded from a database in future iterations?

Should service names be normalized (e.g., “Pet Grooming” vs “pet grooming”)?