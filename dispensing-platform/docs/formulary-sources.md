# Formulary data sources: NZF, NZULM, Pharmac Schedule

Researched on 2026-11-09 from outside New Zealand, which matters for NZF access (see
below). Where a fact could not be verified, this note says so. **The repository holds no
NZF monograph text.** `data/formulary.demo.json` is our own illustrative demo data.

## 1. New Zealand Formulary (NZF): nzf.org.nz

**What we verified**
- The website is geo-restricted. Every path we tried, including `https://www.nzf.org.nz/`,
  `/nzf_1` and `/nzulm`, returned **HTTP 302 to `https://www.nzf.org.nz/home/noaccess`**.
  That page says the NZF "is only able to give access to people currently in NZ, Cook
  Island, Niue and Tokelau". Users outside those places can log in or request access there.
- `https://fhir.nzf.org.nz/` exists and returned **HTTP 403** to an anonymous request.
  We assume this is the authenticated FHIR server, but we have not confirmed it.
- The HL7 NZ "New Zealand Formulary/NZULM" FHIR Implementation Guide was indexed at
  `https://build.fhir.org/ig/HL7NZ/nzf/`, with pages `howtouse.html`, `interactions.html`,
  `data.html` and `faq.html`. Those pages returned **404** when we fetched them (the CI
  build has probably moved or been removed). The points below come from the search
  engine's copy of those pages and should be re-confirmed:
  - NZF provides a full **FHIR API** for NZULM and NZF content, covering prescribing,
    dispensing and medicine reconciliation.
  - Authentication is **OAuth2**, and credentials are issued during **onboarding**.
  - **Access request: email `fhir@nzformulary.org`.** The IG writes it as "fhir 'at' nzformulary.org".
  - **Interactions are contractually restricted.** They "can not be provided via a download
    or for searching via the standard FHIR API". The only way to retrieve them is through
    custom FHIR operations.
  - The IG recommends caching data and syncing incrementally with `_lastUpdated`, rather
    than querying in real time. Content is updated **monthly**.
- Publisher: New Zealand Formulary (New Zealand Medicines Formulary LP). It is funded by
  Health NZ / Te Whatu Ora and is free to view for people in NZ. Background:
  https://www.health.govt.nz/our-work/digital-health/other-digital-health-initiatives/emedicines/new-zealand-formulary
  (2012 bpac article: https://bpac.org.nz/bpj/2012/april/nzf.aspx).

**Not verified**
- **Licence terms and cost for commercial software vendors.** Nothing public was found.
  Ask NZF.
- **The monograph deep-link URL pattern.** We could not fetch any monograph page because
  of the geo-block, and no indexed `nzf.org.nz/nzf_NNNN`-style URLs turned up. **So
  `nzfUrl` is `null` throughout the demo data.** When a licensed feed provides a canonical
  URL per monograph, the NZF adapter puts it in `nzfUrl`, and findings then carry it as
  `trace.link`.

## 2. NZULM: NZ Universal List of Medicines

- It is a list of medicines, not clinical decision support. It "does NOT provide clinical
  decision support information".
- It provides standard names, approval status, Pharmac subsidy status and restrictions,
  Hospital Medicines List and Section 29 products, and some natural products. It is built
  on **NZMT (NZ Medicines Terminology)**, whose identifiers are **SNOMED CT IDs (SCTIDs)**
  at the MP, MPUU, MPP, TPUU, TPP, CTPP and similar levels. Pack-level records link to
  **Pharmacodes**.
- **Access:** it is "free to use" and "available as a free set of downloadable data to
  approved users and vendors". For monthly copies, **email `support@nzulm.org.nz`**. It is
  updated monthly in step with the Pharmac Schedule. The data can also be reached through
  the NZF FHIR API (`Medication`, e.g. `Medication?status=active&nzf-nzmt-type=ctpp`).
  NZMT is also on the Health NZ Terminology Service (NZHTS) FHIR API.
- The old NZULM site is being retired, and search has moved to `nzf.org.nz/nzulm`
  (geo-restricted). Source: https://nzulm-static.pages.dev
- No formal open-data licence text was found. The page says "Crown Copyright, NZ Ministry
  of Health 2022".
- **Recommendation:** key `medicines` rows to the NZMT CTPP/MPUU SCTID and the Pharmacode.
  Key monographs to the MP (ingredient) SCTID, not to free-text ingredient names as the
  demo does.

## 3. Pharmac Pharmaceutical Schedule

- It is published as **XML**, with the schema at `https://schedule.pharmac.govt.nz/2006/07/Schedule.xsd`.
  Archive README: https://schedule.pharmac.govt.nz/pub/HML/archive/README.html
- **Licence: CC BY 4.0.** Attribution must be in writing, and the Pharmac logo must not be
  reproduced. Pharmac accepts no responsibility for errors.
- Files are published around the **23rd of the month** before they take effect. The
  **Pharmacode** is the only identifier that is stable across terminologies. Pharmac's
  other IDs can change without notice.
- Technical support is only for the claiming network. Other queries go to
  `texschedule@pharmac.govt.nz`, with no guaranteed response.
- Uses here: subsidy, patient charge, restrictions and Special Authority flags. It holds
  no clinical dosing or interaction content.

## What the pharmacy owner must obtain

1. **An NZF content licence and API credentials.** Email `fhir@nzformulary.org` (or
   contact NZF through nzf.org.nz) about vendor or pharmacy-software use of NZF content.
   Specifically ask about:
   - the licence terms and cost model, which are not public;
   - permission to store or cache monograph data, given the monthly cadence and `_lastUpdated` sync;
   - **access to interaction data** through the custom FHIR operations, since it is excluded
     from download and standard search;
   - the canonical deep-link URL for each monograph, for `trace.link`;
   - OAuth2 client credentials and the production base URL. We assume it is `fhir.nzf.org.nz`, but this is unverified.
2. **Approved-user access to NZULM monthly data** (`support@nzulm.org.nz`), or NZHTS
   access for NZMT. This lets the `medicines` table carry SCTIDs and Pharmacodes.
3. **Pharmac Schedule XML** (CC BY 4.0), loaded monthly with written attribution. The
   pharmacy's dispensing and claims software provider or the Pharmac claiming network may
   already supply it.
4. **Clinical validation.** A pharmacist must review the thresholds and the severity
   mapping (`contraindicated` to hard stop, `severe` to high, `moderate` to moderate,
   `mild` to info), as well as the 7-day gap tolerance and the duration limits, before any
   live use. Until then, all bundled values are demo data.
5. A wider-coverage interaction or decision-support product may also be needed if NZF
   interaction access is not granted. Commercial NZ options are not evaluated here.

## How the code uses this

- `createNzfSource({ baseUrl, apiKey, fetchImpl })` is a skeleton. Unconfigured, it throws
  `NZF data licence/API not configured`. Configured, it fetches
  `GET {baseUrl}/monographs/{ingredient}` with `Authorization: Bearer <apiKey>` and maps an
  **assumed** JSON shape (documented in `mapNzfResponse`). The real NZF interface is FHIR
  with OAuth2 and custom interaction operations, so the request and the mapper must be
  rewritten once the licensed interface spec is in hand.
- `createFormulary` tries NZF first, from its prefetched cache only, then the local demo
  file. Every finding's `trace.source` names the source that answered and any fallback.
