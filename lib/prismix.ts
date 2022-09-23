import fs from 'fs';
import { promisify } from 'util';
import path from 'path';
import { getDMMF, getConfig } from '@prisma/internals';
import {
  deserializeEnums,
  deserializeDatasources,
  deserializeModels,
  deserializeGenerators
} from './deserializer';
import { DataSource, DMMF, GeneratorConfig } from '@prisma/generator-helper/dist';
import glob from 'glob';
import { CustomAttributes, Field, Model } from './dmmf-extension';
import deepEqual from 'deep-equal';
import { string } from '@oclif/command/lib/flags';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export interface MixerOptions {
  input: string[];
  output: string;
}

export interface PrismixOptions {
  mixers: MixerOptions[];
}

type MixModel = { model: Model, schemaPath: string, fieldRecords: Record<string, Field>, keyFields: string[][] }

type UnPromisify<T> = T extends Promise<infer U> ? U : T;

type Schema = NonNullable<UnPromisify<ReturnType<typeof getSchema>>>;

async function getSchema(schemaPath: string) {
  try {
    const schema = await readFile(path.join(process.cwd(), schemaPath), {
      encoding: 'utf-8'
    });
    const customAttributes = getCustomAttributes(schema);
    const dmmf = await getDMMF({ datamodel: schema });
    const modelFieldRecords: Record<string, { fields: Record<string, Field>} > = {};
    const models: MixModel[] = dmmf.datamodel.models.map((model: Model) => {
      modelFieldRecords[model.name] = { fields: {}};
      let keyFields: string[][] = [];
      if (model.primaryKey?.fields) {
        keyFields.push(model.primaryKey?.fields);
      }
      if (model.uniqueFields) {
        model.uniqueFields.forEach(uniques => keyFields.push(uniques));
      }
      return {
        model: {
          ...model,
          doubleAtIndexes: customAttributes[model.name]?.doubleAtIndexes,
          fields: model.fields.map((field) =>
            // Inject columnName and db.Type from the parsed fieldMappings above
            {
              const attributes = customAttributes[model.name]?.fields[field.name] ?? {};

              modelFieldRecords[model.name].fields[field.name] = {
                ...field,
                columnName: attributes.columnName,
                dbType: attributes.dbType,
                relationOnUpdate: attributes.relationOnUpdate,
                shareable: attributes.shareable,
                inaccessible: attributes.inaccessible,
                external: attributes.external,
                requires: attributes.requires
              }
              if (field.isId || (field.isRequired && field.isUnique)) {
                keyFields.push([field.name]);
              } 
              return modelFieldRecords[model.name].fields[field.name];
            }
          )
        },
        schemaPath: schemaPath,
        fieldRecords: modelFieldRecords[model.name].fields,
        keyFields: keyFields
      }
    });
    const config = await getConfig({ datamodel: schema });

    return {
      models,
      enums: dmmf.datamodel.enums,
      datasources: config.datasources,
      generators: config.generators
    };
  } catch (e) {
    console.error(
      `Prismix failed to parse schema located at "${schemaPath}". Did you attempt to reference to a model without creating an alias? Remember you must define a "blank" alias model with only the "@id" field in your extended schemas otherwise we can't parse your schema.`,
      e
    );
  }
}

function mixModels(inputModels: MixModel[]) {
  const models: Record<string, MixModel> = {};
  //console.log(inputModels);
  for (const newModel of inputModels) {
    console.log(newModel.model.name + "\n");
    newModel.keyFields.forEach(keyfields => console.log("[" + keyfields + "]"));
    const existingModel: MixModel | null = models[newModel.model.name];
    // if the model already exists in our found models, validate the primary key, validate for conflicting fields, and merge non-conflicting fields
    if (existingModel) {
      const existingFieldNames = existingModel.model.fields.map((f) => f.name);
      //First validate if existingModel and newModel have matching primary key
      
      //Validate for conflicting fields, if non-conflicting, proceed to merge field to schema
      for (const newField of newModel.model.fields) {
        if (existingModel.fieldRecords[newField.name]) {
          const existingFieldIndex: number = existingFieldNames.indexOf(newField.name);
          

          // Assign defaults based on existing field if found
          

          // replace the field at this index with the new one
          existingModel.model.fields[existingFieldIndex] = newField;
        } else {
          existingModel.model.fields.push(newField);
        }
      }
      // Assign dbName (@@map) based on new model if existingModel does not have one but newModel does
      if (!existingModel.model.dbName && newModel.model.dbName) {
        existingModel.model.dbName = newModel.model.dbName;
      }

      // Merge doubleAtIndexes (@@index) based on new model if found
      if (newModel.model.doubleAtIndexes?.length) {
        existingModel.model.doubleAtIndexes = [
          ...(existingModel.model.doubleAtIndexes ?? []),
          ...newModel.model.doubleAtIndexes
        ];
      }

      // Merge unique indexes (@@unique) based on new model if found
      if (newModel.model.uniqueIndexes?.length) {
        existingModel.model.uniqueIndexes = [
          ...(existingModel.model.uniqueIndexes ?? []),
          ...newModel.model.uniqueIndexes
        ];
        existingModel.model.uniqueFields = [
          ...(existingModel.model.uniqueFields ?? []),
          ...newModel.model.uniqueFields
        ];
      }
    } else {
      models[newModel.model.name] = newModel;
    }
  }
  return Object.values(models);
}

// Extract @map attributes, which aren't accessible from the prisma SDK
// Adapted from https://github.com/sabinadams/aurora/commit/acb020d868f2ba16b114cf084b959b65d0294a73#diff-8f1b0a136f29e1af67b019f53772aa2e80bf4d24e2c8b844cfa993d8cc9df789
function getCustomAttributes(datamodel: string) {
  // Split the schema up by the ending of each block and then keep each starting with 'model'
  // This should essentially give us an array of the model blocks
  const modelChunks = datamodel.split('\n}');
  return modelChunks.reduce(
    (modelDefinitions: Record<string, CustomAttributes>, modelChunk: string) => {
      // Split the model chunk by line to get the individual fields
      let pieces = modelChunk.split('\n').filter((chunk) => chunk.trim().length);
      // Pull out model name
      const modelName = pieces.find((name) => name.match(/model (.*) {/))?.split(' ')[1];
      if (!modelName) return modelDefinitions;
      // Regex for getting our @map attribute
      const mapRegex = new RegExp(/[^@]@map\("(?<name>.*)"\)/);
      const dbRegex = new RegExp(/(?<type>@db\.(.[^\s@]*))/);
      const federationDirectiveRegex = new RegExp(/\/\/@(?<attribute>shareable|inaccessible|external|requires)/gi);
      const relationOnUpdateRegex = new RegExp(
        /onUpdate: (?<op>Cascade|NoAction|Restrict|SetDefault|SetNull)/
      );
      const doubleAtIndexRegex = new RegExp(/(?<index>@@index\(.*\))/);
      const doubleAtIndexes = pieces
        .reduce((ac: string[], field) => {
          const item = field.match(doubleAtIndexRegex)?.groups?.index;
          return item ? [...ac, item] : ac;
        }, [])
        .filter((f) => f);
      const fieldsWithCustomAttributes = pieces
        .map((field) => {
          const columnName = field.match(mapRegex)?.groups?.name;
          const dbType = field.match(dbRegex)?.groups?.type;
          const relationOnUpdate = field.match(relationOnUpdateRegex)?.groups?.op;
          const federationAttributes = [...field.matchAll(federationDirectiveRegex)]?.map(matches => 
              matches.filter(match => match.includes("//@"))[0].toLowerCase()
          );

          return [field.trim().split(' ')[0], { columnName, dbType, relationOnUpdate, shareable: federationAttributes?.includes("//@shareable"), inaccessible: federationAttributes?.includes("//@inaccessible"), external: federationAttributes?.includes("//@external"), requires: federationAttributes?.includes("//@requires")}] as [
            string,
            CustomAttributes['fields'][0]
          ];
        })
        .filter((f) => f[1]?.columnName || f[1]?.dbType || f[1]?.relationOnUpdate || f[1]?.external || f[1]?.inaccessible || f[1]?.requires || f[1]?.shareable);

      return {
        ...modelDefinitions,
        [modelName]: { fields: Object.fromEntries(fieldsWithCustomAttributes), doubleAtIndexes }
      };
    },
    {}
  );
}

export async function prismix(options: PrismixOptions) {
  for (const mixer of options.mixers) {
    const schemasToMix: Schema[] = [];

    // load the schema data for all inputs
    for (const input of mixer.input) {
      var found = false;
      for (const file of glob.sync(input)) {
        const parsedSchema = await getSchema(file);
        if (parsedSchema) {
          schemasToMix.push(parsedSchema);
          var found = true;
        } 
      }
      if (!found) {
        console.log("Error: No filename : " + input + " found! Please check your prismix.config.json and see if the file exists.");
      }
    }

    // extract all models and mix
    let models: MixModel[] = [];
    for (const schema of schemasToMix) models = [...models, ...schema.models];
    models = mixModels(models);

    let enums: DMMF.DatamodelEnum[] = [];
    schemasToMix.forEach((schema) => !!schema.enums && (enums = [...enums, ...schema.enums]));

    // use the last found datasources
    let datasources: DataSource[] = [];
    schemasToMix.forEach(
      (schema) =>
        schema.datasources.length > 0 &&
        schema.datasources.filter((d) => d.url.value).length > 0 &&
        (datasources = schema.datasources)
    );
    // use the last found generators
    let generators: GeneratorConfig[] = [];
    schemasToMix.forEach(
      (schema) => schema.generators.length > 0 && (generators = schema.generators)
    );

    let outputSchema = [
      '// *** GENERATED BY PRISMIX :: DO NOT EDIT ***',
      await deserializeDatasources(datasources),
      await deserializeGenerators(generators),
      await deserializeModels(models.map(mixModel => mixModel.model)),
      await deserializeEnums(enums)
    ]
      .filter((e) => e)
      .join('\n');

    await writeFile(path.join(process.cwd(), mixer.output), outputSchema);
  }
}
