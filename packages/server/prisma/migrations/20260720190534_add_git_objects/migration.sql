-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "defaultBranch" TEXT NOT NULL DEFAULT 'main';

-- CreateTable
CREATE TABLE "git_objects" (
    "repositoryId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_objects_pkey" PRIMARY KEY ("repositoryId","id")
);

-- CreateTable
CREATE TABLE "git_refs" (
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commitId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_refs_pkey" PRIMARY KEY ("repositoryId","name")
);

-- AddForeignKey
ALTER TABLE "git_objects" ADD CONSTRAINT "git_objects_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_refs" ADD CONSTRAINT "git_refs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
