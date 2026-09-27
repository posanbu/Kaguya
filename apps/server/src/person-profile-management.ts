/** 人物画像管理只操作已保存版本；运行时生效索引由服务启动时固定。 */
import {
  manualPersonProfileSectionsSchema,
  emptyPersonProfileMetadata,
  personProfileSaveSchema,
  personProfileViewSchema,
  type ManualPersonProfileSections,
  type PersonProfileMetadata,
} from "@kaguya/schema";
import { renderPersonProfileSections } from "@kaguya/modules";
import {
  PersonProfileStoreError,
  type ActivePersonProfileSnapshot,
  type KaguyaDatabase,
  type StoredPersonProfile,
} from "@kaguya/database";
import { readPrimaryAccounts } from "./person-basics.js";

export class PersonProfileManagement {
  constructor(
    private readonly database: () => KaguyaDatabase | undefined,
    private readonly active: ActivePersonProfileSnapshot,
  ) {}

  private requireDatabase(): KaguyaDatabase {
    const database = this.database();
    if (!database)
      throw new PersonProfileStoreError("profile_unavailable", 503);
    return database;
  }

  async get(personInformationId: string) {
    return this.view(
      await this.requireDatabase().personProfiles.get(personInformationId),
    );
  }

  async save(personInformationId: string, input: unknown) {
    const parsed = personProfileSaveSchema.safeParse(input);
    if (!parsed.success)
      throw new PersonProfileStoreError("invalid_profile", 400);
    return this.view(
      await this.requireDatabase().personProfiles.save(
        personInformationId,
        parsed.data.revision,
        parsed.data.sections,
        parsed.data.metadata,
      ),
    );
  }

  async preview(personInformationId: string, input: unknown) {
    const legacy = manualPersonProfileSectionsSchema.safeParse(input);
    const full = personProfileSaveSchema
      .omit({ revision: true })
      .safeParse(input);
    if (!legacy.success && !full.success)
      throw new PersonProfileStoreError("invalid_profile", 400);
    const sections = legacy.success ? legacy.data : full.data!.sections;
    const metadata =
      full.success && full.data.metadata
        ? full.data.metadata
        : (await this.requireDatabase().personProfiles.get(personInformationId))
            .metadata;
    return this.render(personInformationId, sections, metadata);
  }

  private async view(profile: StoredPersonProfile) {
    const activeRevision =
      this.active.revisions.get(profile.personInformationId) ?? 0;
    const rendered = await this.render(
      profile.personInformationId,
      profile.sections,
      profile.metadata,
    );
    const activeName =
      this.active.metadataByPerson.get(profile.personInformationId)
        ?.primaryName || rendered.initialName;
    return personProfileViewSchema.parse({
      personInformationId: profile.personInformationId,
      revision: profile.revision,
      activeRevision,
      sections: profile.sections,
      metadata: profile.metadata,
      preview: rendered.preview,
      previewName: rendered.previewName,
      activeName,
      activeKnownStatus:
        this.active.metadataByPerson.get(profile.personInformationId)
          ?.knownStatus ?? "unset",
      restartRequired: activeRevision !== profile.revision,
      effect: "restart_required",
    });
  }

  private async render(
    personInformationId: string,
    sections: ManualPersonProfileSections | StoredPersonProfile["sections"],
    metadata: PersonProfileMetadata = emptyPersonProfileMetadata(),
  ) {
    const person =
      await this.requireDatabase().information.get(personInformationId);
    if (person?.kind !== "memory.identity.person.entity")
      throw new PersonProfileStoreError("person_not_found", 404);
    const accounts = await readPrimaryAccounts(this.requireDatabase(), [
      personInformationId,
    ]);
    const accountId =
      accounts.get(personInformationId)?.accountId ||
      (typeof person.payload.accountId === "string"
        ? person.payload.accountId
        : undefined);
    const initialName =
      this.active.initialNames.get(personInformationId) ||
      String(person.payload.initialName ?? accountId ?? personInformationId);
    return {
      preview: renderPersonProfileSections(
        sections,
        accountId ? `speaker:${accountId}` : `person:${personInformationId}`,
        { personInformationId, metadata, initialName },
      ),
      previewName: metadata.primaryName || initialName,
      initialName,
    };
  }
}
