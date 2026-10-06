# GeoRhizome AI Enterprise Architecture

## Overview
GeoRhizome AI is an enterprise-grade, localized AI Knowledge Management System built to securely distribute corporate intelligence without relying on centralized cloud inference. By utilizing a decentralized, containerized architecture, the system allows administrators to curate and deploy complex vector databases seamlessly to standard employee hardware with zero friction.

This repository serves as the core source code and distribution hub for the GeoRhizome AI ecosystem.

---

## High-Level System Architecture

The system operates on a hub-and-spoke distribution model. GitHub acts as the secure, serverless intermediary for both software container updates and heavy vector database synchronization.

```mermaid
graph TD
    %% Entities
    Admin[Administrator Workstation]
    Employee[Employee Laptops]
    Repo[GitHub Source Repository]
    GHCR[GitHub Container Registry]
    Releases[GitHub Releases]
    LocalLLM[Local Inference Engine]

    %% Admin Workflows
    Admin -->|1. Pushes Source Code| Repo
    Repo -->|2. CI/CD Compiles Image| GHCR
    Admin -->|3. Uploads Computed Vectors| Releases

    %% Employee Workflows
    Employee -->|4. OTA Update Shortcut| GHCR
    Employee -->|5. Native Sync Request| Releases
    Employee -->|6. Offline Query| LocalLLM

    %% Styling
    classDef hub fill:#2d3748,stroke:#4a5568,stroke-width:2px,color:#fff;
    classDef edge fill:#4a5568,stroke:#718096,stroke-width:2px,color:#fff;
    class Repo,GHCR,Releases hub;
    class Admin,Employee,LocalLLM edge;
```

---

## Core Capabilities

### 1. Zero-Friction Automated Deployment
End-users are not required to possess terminal experience or DevOps knowledge. The platform provides automated `install.ps1` (Windows) and `install.sh` (macOS/Linux) payloads that:
- Conduct hardware profiling to determine the optimal deployment configuration.
- Silently authenticate with the private Container Registry using embedded, obfuscated credentials.
- Pull the pre-compiled Docker images and generate native Desktop shortcuts for application launch.

### 2. Pre-Computed Knowledge Synchronization
Vectorizing thousands of pages of corporate documentation requires significant compute power. GeoRhizome AI shifts this burden entirely to the Administrator.
- **Admin Upload:** The Administrator ingests heavy PDFs on a high-performance workstation. The system's Node.js backend compresses the resulting LanceDB vector tables and SQLite metadata into a `vectors.tar.gz` artifact and pushes it to a specific GitHub Release tag (e.g., `workspace-company-guidelines`).
- **Employee Sync:** The employee simply clicks "Sync" in their local UI. The backend fetches the artifact, bypasses the embedding process, and uses Prisma to `upsert` the workspace metadata directly into their local environment.

```mermaid
sequenceDiagram
    participant Admin as Administrator
    participant Hub as GitHub Releases
    participant Core as GeoRhizome Backend
    participant DB as SQLite / LanceDB
    participant Emp as Employee

    Note over Admin,Hub: Administrator Push Phase
    Admin->>Core: Click "Upload Vectors"
    Core->>DB: Compress Vector Tables & Metadata
    Core->>Hub: Upload vectors.tar.gz via REST API
    
    Note over Hub,Emp: Employee Pull Phase
    Emp->>Core: Click "Sync Workspace"
    Core->>Hub: Download vectors.tar.gz
    Core->>DB: Extract LanceDB & Upsert Mappings
    Core-->>Emp: Sync Complete (Zero Compute Cost)
```

### 3. Over-The-Air (OTA) Updates
The deployment utilizes a strictly `latest`-tagged CI/CD pipeline to eliminate version fragmentation among employees.
- When source code is pushed to the `main` branch, a GitHub Action automatically compiles the new Vite frontend and Express backend into a unified Docker image.
- Employees execute a generated "Update" desktop shortcut, which triggers a `docker compose pull` to silently replace their local containers with the newest iteration.

### 4. Granular Data Governance
Employees maintain full control over their local storage allocations. A native API endpoint (`DELETE /system/workspace-vectors/:slug`) allows users to instantly purge vector data from their hard drives. The backend surgically drops `workspace_documents` mappings in Prisma and securely deletes the physical LanceDB directory without interrupting the main container runtime.

---

## Technical Stack

- **Frontend:** React, Vite, TailwindCSS
- **Backend:** Node.js, Express
- **Database Engine:** Prisma ORM, SQLite (Relational), LanceDB (Vector)
- **Containerization:** Docker, Docker Compose
- **CI/CD Pipeline:** GitHub Actions, GitHub Container Registry (GHCR)

---

## Licensing & Confidentiality

**PROPRIETARY AND CONFIDENTIAL**

This software and its associated documentation are the proprietary and confidential property of BAIZ1D (GeoRhizome AI). Unauthorized copying, distribution, or reverse-engineering of this repository, via any medium, is strictly prohibited. All rights reserved.
