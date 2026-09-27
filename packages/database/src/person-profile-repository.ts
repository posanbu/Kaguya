/** 管理端人物画像的串行版本写入；原子只追加，当前版本按账本注册顺序计算。 */
import { randomUUID } from "node:crypto";
import {
  PERSON_PROFILE_REVISION_KIND,
  emptyPersonProfileMetadata,
  emptyPersonProfileSections,
  freezeInformationAtom,
  informationAtomSchema,
  manualPersonProfileSectionsSchema,
  personProfileMetadataSchema,
  personProfileRevisionPayloadSchema,
  type ManualPersonProfileSections,
  type PersonProfileMetadata,
  type PersonProfileSections,
} from "@kaguya/schema";
import { appendInformationAtom } from "./information-repository.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

const PERSON_KIND = "memory.identity.person.entity";
const ACCOUNT_KIND = "memory.identity.platform.account.entity";
const BINDING_KIND = "memory.identity.platform.account.binding";

export class PersonProfileStoreError extends Error {
  constructor(
    readonly code:
      | "person_not_found"
      | "profile_changed"
      | "invalid_profile"
      | "profile_unavailable",
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}

type RevisionRow = Record<string, unknown> & {
  information_id: string;
  payload: unknown;
};

export interface StoredPersonProfile {
  readonly personInformationId: string;
  readonly informationId?: string;
  readonly revision: number;
  readonly sections: PersonProfileSections;
  readonly metadata: PersonProfileMetadata;
}

export interface ActivePersonProfileSnapshot {
  readonly byPerson: ReadonlyMap<string, string>;
  readonly byAccount: ReadonlyMap<
    string,
    { personInformationId: string; profileInformationId: string }
  >;
  readonly revisions: ReadonlyMap<string, number>;
  readonly metadataByPerson: ReadonlyMap<string, PersonProfileMetadata>;
  readonly initialNames: ReadonlyMap<string, string>;
}

export function profileAccountKey(
  platform: string,
  adapterId: string,
  accountId: string,
): string {
  return JSON.stringify([platform, adapterId, accountId]);
}

export class PersonProfileRepository {
  constructor(private readonly database: SqlDatabase) {}

  async get(personInformationId: string): Promise<StoredPersonProfile> {
    return this.database.transaction(async (tx) => {
      await assertPerson(tx, personInformationId);
      return readCurrent(tx, personInformationId);
    });
  }

  async save(
    personInformationId: string,
    expectedRevision: number,
    sections: ManualPersonProfileSections,
    metadata?: PersonProfileMetadata,
  ): Promise<StoredPersonProfile> {
    const parsed = manualPersonProfileSectionsSchema.safeParse(sections);
    const parsedMetadata =
      metadata === undefined
        ? undefined
        : personProfileMetadataSchema.safeParse(metadata);
    if (
      !parsed.success ||
      (parsedMetadata !== undefined && !parsedMetadata.success) ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new PersonProfileStoreError("invalid_profile", 400);
    return this.database.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 6112))",
        [personInformationId],
      );
      await assertPerson(tx, personInformationId);
      const current = await readCurrent(tx, personInformationId);
      if (current.revision !== expectedRevision)
        throw new PersonProfileStoreError("profile_changed", 409);
      const informationId = randomUUID();
      const payload = personProfileRevisionPayloadSchema.parse({
        personInformationId,
        revision: current.revision + 1,
        sections: parsed.data,
        metadata: parsedMetadata?.data ?? current.metadata,
        previousRevisionInformationId: current.informationId ?? null,
      });
      const atom = freezeInformationAtom(
        informationAtomSchema.parse({
          informationId,
          kind: PERSON_PROFILE_REVISION_KIND,
          occurredAt: new Date().toISOString(),
          source: "management:person-profile",
          payload,
          references: [
            {
              relation: "memory:profile-of",
              informationId: personInformationId,
            },
            ...(current.informationId
              ? [
                  {
                    relation: "memory:previous-profile",
                    informationId: current.informationId,
                  },
                ]
              : []),
          ],
        }),
      );
      await appendInformationAtom(
        tx,
        atom,
        [
          {
            relation: "memory:profile-of",
            required: true,
            multiple: false,
            targetKinds: [PERSON_KIND],
          },
          {
            relation: "memory:previous-profile",
            required: false,
            multiple: false,
            targetKinds: [PERSON_PROFILE_REVISION_KIND],
          },
        ],
        { enqueueLogProjection: true },
      );
      return {
        personInformationId,
        informationId,
        revision: payload.revision,
        sections: payload.sections,
        metadata: payload.metadata ?? emptyPersonProfileMetadata(),
      };
    });
  }

  async loadActiveSnapshot(): Promise<ActivePersonProfileSnapshot> {
    const rows = await this.database.query<{
      person_information_id: string;
      profile_information_id: string;
      revision: number;
      profile_payload: unknown;
      platform: string | null;
      adapter_id: string | null;
      account_id: string | null;
    }>(
      `WITH current_profiles AS (
         SELECT DISTINCT ON (a.payload->>'personInformationId')
           a.payload->>'personInformationId' AS person_information_id,
           a.information_id AS profile_information_id,
           (a.payload->>'revision')::integer AS revision
           ,a.payload AS profile_payload
         FROM information_atoms a
         JOIN information_lifecycle l ON l.information_id=a.information_id
         WHERE a.kind=$1
         ORDER BY a.payload->>'personInformationId', l.position DESC
       )
       SELECT p.*, account.payload->>'platform' AS platform,
         account.payload->>'adapterId' AS adapter_id,
         account.payload->>'accountId' AS account_id
       FROM current_profiles p
       LEFT JOIN information_atoms binding
         ON binding.kind=$2 AND binding.payload->>'personInformationId'=p.person_information_id
       LEFT JOIN information_references r
         ON r.information_id=binding.information_id AND r.relation='core:binds'
       LEFT JOIN information_atoms account
         ON account.information_id=r.target_information_id AND account.kind=$3`,
      [PERSON_PROFILE_REVISION_KIND, BINDING_KIND, ACCOUNT_KIND],
    );
    const byPerson = new Map<string, string>();
    const byAccount = new Map<
      string,
      { personInformationId: string; profileInformationId: string }
    >();
    const revisions = new Map<string, number>();
    const metadataByPerson = new Map<string, PersonProfileMetadata>();
    for (const row of rows.rows) {
      byPerson.set(row.person_information_id, row.profile_information_id);
      revisions.set(row.person_information_id, row.revision);
      metadataByPerson.set(
        row.person_information_id,
        personProfileRevisionPayloadSchema.parse(row.profile_payload)
          .metadata ?? emptyPersonProfileMetadata(),
      );
      if (row.platform && row.adapter_id && row.account_id)
        byAccount.set(
          profileAccountKey(row.platform, row.adapter_id, row.account_id),
          {
            personInformationId: row.person_information_id,
            profileInformationId: row.profile_information_id,
          },
        );
    }
    const nameRows = await this.database.query<{
      person_information_id: string;
      initial_name: string;
    }>(
      `SELECT p.information_id AS person_information_id,
         COALESCE(NULLIF(p.payload->>'initialName',''),
           NULLIF(inbound.payload#>>'{source,sender,nickname}',''),
           p.payload->>'accountId',
           p.information_id) AS initial_name
       FROM information_atoms p
       LEFT JOIN information_references r
         ON r.information_id=p.information_id AND r.relation='core:caused-by'
       LEFT JOIN information_atoms inbound
         ON inbound.information_id=r.target_information_id
       WHERE p.kind=$1`,
      [PERSON_KIND],
    );
    const initialNames = new Map(
      nameRows.rows.map((row) => [row.person_information_id, row.initial_name]),
    );
    return { byPerson, byAccount, revisions, metadataByPerson, initialNames };
  }
}

async function assertPerson(tx: SqlTransaction, personInformationId: string) {
  const rows = await tx.query<{ kind: string }>(
    "SELECT kind FROM information_atoms WHERE information_id=$1",
    [personInformationId],
  );
  if (rows.rows[0]?.kind !== PERSON_KIND)
    throw new PersonProfileStoreError("person_not_found", 404);
}

async function readCurrent(
  tx: SqlTransaction,
  personInformationId: string,
): Promise<StoredPersonProfile> {
  const rows = await tx.query<RevisionRow>(
    `SELECT a.information_id,a.payload FROM information_atoms a
     JOIN information_lifecycle l ON l.information_id=a.information_id
     WHERE a.kind=$1 AND a.payload->>'personInformationId'=$2
     ORDER BY l.position DESC LIMIT 1`,
    [PERSON_PROFILE_REVISION_KIND, personInformationId],
  );
  const row = rows.rows[0];
  if (!row)
    return {
      personInformationId,
      revision: 0,
      sections: emptyPersonProfileSections(),
      metadata: emptyPersonProfileMetadata(),
    };
  const parsed = personProfileRevisionPayloadSchema.parse(row.payload);
  return {
    personInformationId,
    informationId: row.information_id,
    revision: parsed.revision,
    sections: parsed.sections,
    metadata: parsed.metadata ?? emptyPersonProfileMetadata(),
  };
}
