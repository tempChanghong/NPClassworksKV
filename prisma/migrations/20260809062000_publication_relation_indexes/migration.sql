-- Manual relation indexes required because this project uses relationMode = prisma.

CREATE INDEX "Publication_certifiedByAccountId_idx"
    ON "Publication"("certifiedByAccountId");
CREATE INDEX "ClassroomScreenBinding_createdByAccountId_idx"
    ON "ClassroomScreenBinding"("createdByAccountId");
CREATE INDEX "PublicationRevision_editorAccountId_idx"
    ON "PublicationRevision"("editorAccountId");
CREATE INDEX "PublicationRevision_certifiedByAccountId_idx"
    ON "PublicationRevision"("certifiedByAccountId");
