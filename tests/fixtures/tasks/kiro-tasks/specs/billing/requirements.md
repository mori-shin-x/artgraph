# Requirements

## Introduction

Billing requirements. Added for issue #435: before it, the sibling `tasks.md`'s
`_Requirements: 7.1, 8.2, …` entries resolved into the *task* ID space, so this
file was not needed for the fixture to be meaningful. Now they resolve to
`Requirement-7` / `Requirement-8` / `Requirement-9`, and without these headings
every task-tag `verifies` edge in the fixture would dangle.

### Requirement 7

**User Story:** As an operator, I want a billing module.

#### Acceptance Criteria

1. WHEN a charge is created THEN the system SHALL persist it.
2. WHEN a charge fails THEN the system SHALL retry.
3. WHEN a Stripe webhook arrives THEN the system SHALL verify its signature.

### Requirement 8

**User Story:** As an operator, I want invoices.

#### Acceptance Criteria

1. WHEN a webhook is received THEN the system SHALL validate the signature.
2. WHEN a billing period closes THEN the system SHALL generate an invoice.

### Requirement 9

**User Story:** As an operator, I want invoice delivery.

#### Acceptance Criteria

1. WHEN an invoice is generated THEN the system SHALL email it.
