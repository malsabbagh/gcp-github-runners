# Transaction transport compatibility

The November 1 diagnosis below identifies a pinned emulator query-transcoding
bug, not an invalid production GET request. Official Firebase download metadata
was rechecked on November 2 and still selects emulator 1.22.0 with the same
checksum; no verified fixed upgrade was found.

The reviewed remedy deliberately moves production single-document transaction
reads to POST `batchGet`, aligning the read primitive with locked Node SDK7.11.2.
The transaction stays in its original base64 form in JSON. Exactly one found or
missing result must match the requested full resource name; malformed/error rows,
wrong names and HTTP errors cannot become absence. No GET timeout fallback,
new provider, credential, permission, state schema or lifetime authority is added.
409/429 errors still enter the existing fresh-transaction retry/rollback policy.

The integration harness keeps the original GET method in an explicit legacy
diagnostic subclass and retains all three failing assertions. Added current
production-path cases call the real method without overriding it. This remedies
the adapter's emulator compatibility without pretending the emulator GET bug is
fixed, hiding failed history, or qualifying live Firestore.

## Historical diagnosis before the remedy

## Contract and observed failure

The production Python `Pool.get_document` calls document GET with a URL-escaped
base64 `transaction` query argument. The official
[GET reference](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/get)
explicitly permits that argument. The
[Firestore API definition](https://github.com/googleapis/googleapis/blob/master/google/firestore/v1/firestore.proto)
declares the transaction selector as protobuf `bytes`, and maps GetDocument to
HTTP GET. A request body is not permitted for this operation.

The pinned emulator accepts beginTransaction but fails while converting the GET
query argument, before returning a document or a normal API error. Its log stack
passes through `HttpAdapter.setFieldValues`, `mergeFields` and `toJavaType`, then
reports `Unmapped JavaType: BYTE_STRING`; the client reaches its 30-second timeout.
Read-only inspection using the existing JDK's `javap -p -c` on the checksummed
1.22.0 JAR shows `toJavaType` handles numeric, boolean, string and enum values,
and throws for unsupported JavaTypes. Its conversion table has no bytes case.
This is an emulator query-transcoding limitation, not evidence of an incorrectly
escaped transaction or a failure of production Firestore's documented API.

The upstream emulator's open
[issue 3293](https://github.com/firebase/firebase-tools/issues/3293) reports the
same transactional GET hang and parser error. This project's original failing
tests remain active, including the waiting cursor's GET.

The locked Node SDK 7.11.2 document reader uses the
[BatchGetDocuments RPC](https://github.com/googleapis/nodejs-firestore/blob/v7.11.2/dev/src/document-reader.ts),
so successful SDK reads do not exercise that REST query parser. The documented
[REST batchGet operation](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet)
puts the same transaction selector in a JSON request body. The test-only Python
subclass uses that operation for explicitly labelled comparisons. It binds each
single-document found/missing response to the requested resource name; it does
not assume response order. All other Python transaction, query and codec methods
remain the source methods. Positive comparisons qualify only that test path.

## Bounded options

1. Keep this diagnostic and wait for an official emulator fix. The current
   [Firebase CLI emulator metadata](https://github.com/firebase/firebase-tools/blob/master/src/emulator/downloadableEmulatorInfo.json)
   still selects 1.22.0 with this JAR's checksum. No verified fixed version was
   identified. A future official version needs a reviewed checksum/tool pin and
   a rerun of the original tests; updating the CLI alone is not a demonstrated
   fix. No alternative version was installed or launched here.
2. Separately review a production adapter change to transactional single-document
   batchGet. This is a documented production API and aligns the read primitive
   with the Node SDK, but changes the wire response contract: missing documents
   are response entries rather than GET 404s, and responses must be matched by
   full name. Strict parsing, malformed/missing response tests, retry/error
   behavior and the existing provider build path would need qualification. The
   comparison provides useful evidence, not authorization or sufficient proof
   for that product change. Do not silently fall back from GET after a timeout.
3. Separately authorize a tightly bounded remote Firestore adapter trial to test
   the original GET contract. This would require a concrete project, database,
   principal, operation/time/cost scope and cleanup plan. It would not establish
   full runner lifecycle behavior. No remote trial is included in this harness.

The [emulator limitations](https://firebase.google.com/docs/emulator-suite/connect_firestore#how_the_cloud_firestore_emulator_differs_from_production)
also mean passing local transactions do not establish production contention,
indexes, IAM, quotas, networking or paid runner behavior.
