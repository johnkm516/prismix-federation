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

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export interface MixerOptions {
  input: string[];
  output: string;
}

export interface PrismixOptions {
  mixers: MixerOptions[];
}

type UnPromisify<T> = T extends Promise<infer U> ? U : T;

type Schema = NonNullable<UnPromisify<ReturnType<typeof getSchema>>>;

async function getSchema(schemaPath: string) {
  try {
    const schema = await readFile(path.join(process.cwd(), schemaPath), {
      encoding: 'utf-8'
    });

    const dmmf = await getDMMF({ datamodel: schema });
    const customAttributes = getCustomAttributes(schema);
    const models: Model[] = dmmf.datamodel.models.map((model: Model) => ({
      ...model,
      doubleAtIndexes: customAttributes[model.name]?.doubleAtIndexes,
      fields: model.fields.map((field) =>
        // Inject columnName and db.Type from the parsed fieldMappings above
        {
          const attributes = customAttributes[model.name]?.fields[field.name] ?? {};

          return {
            ...field,
            columnName: attributes.columnName,
            dbType: attributes.dbType,
            relationOnUpdate: attributes.relationOnUpdate,
            shareable: attributes.shareable,
            inaccessible: attributes.inaccessible,
            external: attributes.external,
            requires: attributes.requires
          };
        }
      )
    }));
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

function mixModels(inputModels: Model[]) {
  const models: Record<string, Model> = {};
  for (const newModel of inputModels) {
    const existingModel: Model | null = models[newModel.name];
    // if the model already exists in our found models, validate the primary key, validate for conflicting fields, and merge non-conflicting fields
    //console.log(existingModel);
    if (existingModel) {
      //First validate if existingModel and newModel have matching primary key
      

      //Validate for conflicting fields, if non-conflicting, proceed to merge field to schema
      for (const newField of newModel.fields) {
        // if this field exists in the existing model
        var found = false;
        for (const existingField of existingModel.fields) {
          //if the model already contains a field with the same name
          if (existingField.name === newField.name) {
            found = true;
            //if matching fieldname but does not contain all the same field properties
            if (!(deepEqual(existingField, newField))) {
                console.error("Field " + existingField.name + " of model " + existingModel.name + " mismatch! Please check all prisma schemas for model " + existingModel.name + ".");
                //console.log(existingField);
                //console.log(newField);
            }
          } 
        }
        if (!found) {
          // if it doesn't already exist, append to field list
          existingModel.fields.push(newField);
        }
      }
      // Assign dbName (@@map) based on new model if found
      if (!existingModel.dbName && newModel.dbName) {
        existingModel.dbName = newModel.dbName;
      }

      // Merge doubleAtIndexes (@@index) based on new model if found
      if (newModel.doubleAtIndexes?.length) {
        existingModel.doubleAtIndexes = [
          ...(existingModel.doubleAtIndexes ?? []),
          ...newModel.doubleAtIndexes
        ];
      }

      // Merge unique indexes (@@unique) based on new model if found
      if (newModel.uniqueIndexes?.length) {
        existingModel.uniqueIndexes = [
          ...(existingModel.uniqueIndexes ?? []),
          ...newModel.uniqueIndexes
        ];
        existingModel.uniqueFields = [
          ...(existingModel.uniqueFields ?? []),
          ...newModel.uniqueFields
        ];
      }
    } else {
      models[newModel.name] = newModel;
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
          console.log(field);
          const columnName = field.match(mapRegex)?.groups?.name;
          const dbType = field.match(dbRegex)?.groups?.type;
          const relationOnUpdate = field.match(relationOnUpdateRegex)?.groups?.op;
          const federationAttributes = [...field.matchAll(federationDirectiveRegex)]?.map(matches => 
              matches.filter(match => match.includes("//@"))[0].toLowerCase()
          );

          [...field.matchAll(federationDirectiveRegex)].forEach(element => console.log(element));

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
    let models: Model[] = [];
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
      await deserializeModels(models),
      await deserializeEnums(enums)
    ]
      .filter((e) => e)
      .join('\n');

    await writeFile(path.join(process.cwd(), mixer.output), outputSchema);
  }
}
