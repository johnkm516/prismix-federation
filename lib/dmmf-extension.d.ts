import { DMMF } from '@prisma/generator-helper/dist';
export type CustomFieldAttributes = {
  columnName?: string;
  dbType?: string;
  relationOnUpdate?: string;
  isKeyField?: boolean;
  shareable?: boolean;
  inaccessible?: boolean;
  external?: boolean;
  requires?: boolean;
};
export type CustomModelAttributes = { 
  doubleAtIndexes?: string[], 
  isStub?: boolean
};

export type CustomAttributes = {
  fields: Record<string, CustomFieldAttributes>;
} & CustomModelAttributes;

export type Field = DMMF.Field & CustomFieldAttributes;
export type Model = DMMF.Model & {
  fields: Field[];
} & CustomModelAttributes;
