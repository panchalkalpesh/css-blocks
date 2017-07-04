/**
 * @module "TemplateAnalysis"
 */
import { BlockObject } from "../Block/BlockObject";
import { Block } from "../Block/Block";
// tslint:disable-next-line:no-unused-variable Imported for Documentation link
import { CLASS_NAME_IDENT } from "../BlockParser";
import { StyleAnalysis } from "./StyleAnalysis";

interface TemplateInfoConstructor {
    deserialize<TI extends TemplateInfo>(identifier: string, ...data: any[]): TI;
}

class TemplateInfoFactory {
  static constructors: Map<Symbol, TemplateInfoConstructor> = new Map();
  static register(name: string, constructor: TemplateInfoConstructor) {
    TemplateInfoFactory.constructors.set(Symbol.for(name), constructor);
  }
  static create<TemplateInfoType extends TemplateInfo>(name: string, identifier: string, ...data: any[]): TemplateInfoType {
    let constructor: TemplateInfoConstructor | undefined = TemplateInfoFactory.constructors.get(Symbol.for(name));
    if (constructor) {
      return constructor.deserialize<TemplateInfoType>(identifier, ...data);
    } else {
      throw new Error(`No template info registered for ${name}`);
    }
  }
  static deserialize<TemplateInfoType extends TemplateInfo>(obj: SerializedTemplateInfo): TemplateInfoType {
    let data: any[] = obj.data || [];
    return TemplateInfoFactory.create<TemplateInfoType>(obj.type, obj.identifier, ...data);
  }
}

export interface SerializedTemplateInfo {
  type: string;
  identifier: string;
  data?: any[];
}

/**
 * Base class for template information for an analyzed template.
 */
export class TemplateInfo {
  static typeName = "CssBlocks.TemplateInfo";
  identifier: string;

  constructor(identifier: string) {
    this.identifier = identifier;
  }

  static deserialize(identifier: string, ..._data: any[]): TemplateInfo {
    return new TemplateInfo(identifier);
  }

  // Subclasses should override this and set type to the string value that their class is registered as.
  // any additional data for serialization
  serialize(): SerializedTemplateInfo {
    return {
      type: TemplateInfo.typeName,
      identifier: this.identifier,
    };
  }
}

TemplateInfoFactory.register(TemplateInfo.typeName, TemplateInfo);

/**
 * This interface defines a JSON friendly serialization
 * of a {TemplateAnalysis}.
 */
export interface SerializedTemplateAnalysis {
  template: SerializedTemplateInfo;
  blocks: {
    [localName: string]: string;
  };
  stylesFound: string[];
  dynamicStyles: number[];
   // The numbers stored in each correlation are an index into a stylesFound;
  styleCorrelations: number[][];
}

/**
 * A TemplateAnalysis performs book keeping and ensures internal consistency of the block objects referenced
 * within a template. It is designed to be used as part of an AST walk over a template.
 *
 * 1. Call [[startElement startElement()]] at the beginning of an new html element.
 * 2. Call [[addStyle addStyle(blockObject)]] for all the styles used on the current html element.
 * 2. Call [[markDynamic markDynamic(blockObject)]] for all the styles used dynamically on the current html element.
 * 3. Call [[endElement endElement()]] when done adding styles for the current element.
 */
export class TemplateAnalysis<Template extends TemplateInfo> implements StyleAnalysis {

  template: Template;
  /**
   * A map from a local name for the block to the [[Block]].
   * The local name must be a legal CSS ident/class name but this is not validated here.
   * See [[CLASS_NAME_IDENT]] for help validating a legal class name.
   */
  blocks: {
    [localName: string]: Block;
  };

  /**
   * All the block styles used in this template. Due to how Set works, it's exceedingly important
   * that the same instance for the same block object is used over the course of a single template analysis.
   */
  stylesFound: Set<BlockObject>;
  /**
   * All the block styles used in this template that may be applied dynamically.
   * Dynamic styles are an important signal to the optimizer.
   */
  dynamicStyles: Set<BlockObject>;
  /**
   * A list of all the styles that are used together on the same element.
   * The current correlation is added to this list when [[endElement]] is called.
   */
  styleCorrelations: Set<BlockObject>[];
  /**
   * The current correlation is created when calling [[startElement]].
   * The current correlation is unset after calling [[endElement]].
   */
  currentCorrelation: Set<BlockObject> | undefined;

  /**
   * @param template The template being analyzed.
   */
  constructor(template: Template) {
    this.template = template;
    this.blocks = {};
    this.stylesFound = new Set();
    this.dynamicStyles = new Set();
    this.styleCorrelations = [];
  }

  /**
   * @param block The block for which the local name should be returned.
   * @return The local name of the given block.
   */
  getBlockName(block: Block): string | null {
    let names = Object.keys(this.blocks);
    for (let i = 0; i < names.length; i++) {
      if (this.blocks[names[i]] === block) {
        return names[i];
      }
    }
    return null;
  }

  /**
   * @param obj The block object referenced on the current element.
   */
  addStyle(obj: BlockObject): this {
    this.stylesFound.add(obj);
    if (!this.currentCorrelation) {
      this.currentCorrelation = new Set();
    }
    this.currentCorrelation.add(obj);
    return this;
  }

  /**
   * @param obj the block object that is used dynamically. Must have already been added via [[addStyle]]
   */
  markDynamic(obj: BlockObject): this {
    if (this.stylesFound.has(obj)) {
      this.dynamicStyles.add(obj);
    } else {
      throw new Error("Cannot mark style that hasn't yet been added as dynamic.");
    }
    return this;
  }

  /**
   * Indicates a new element found in a template. no allocations are performed until a style is added
   * so it is safe to call before you know whether there are any syles on the current element.
   * Allways call [[endElement]] before calling the next [[startElement]], even if the elements are nested in the document.
   */
  startElement(): this {
    if (this.currentCorrelation && this.currentCorrelation.size > 0) {
      throw new Error("endElement wasn't called after a previous call to startElement");
    }
    this.currentCorrelation = undefined;
    return this;
  }

  /**
   * Indicates all styles for the element have been found.
   */
  endElement(): this {
    if (this.currentCorrelation && this.currentCorrelation.size > 0) {
      this.styleCorrelations.push(this.currentCorrelation);
      this.currentCorrelation = undefined;
    }
    return this;
  }

  /**
   * @return The local name for the block object using the local prefix for the block.
   */
  serializedName(o: BlockObject): string {
    return `${this.getBlockName(o.block) || ''}${o.asSource()}`;
  }

  referencedBlocks(): Block[] {
    return Object.keys(this.blocks).map(k => this.blocks[k]);
  }

  transitiveBlockDependencies(): Set<Block> {
    let deps = new Set<Block>();
    this.referencedBlocks().forEach((block) => {
      deps.add(block);
      let moreDeps = block.transitiveBlockDependencies();
      if (moreDeps.size > 0) {
        deps = new Set([...deps, ...moreDeps]);
      }
    });
    return deps;
  }

  blockDependencies(): Set<Block> {
    return new Set<Block>(this.referencedBlocks());
  }

  areCorrelated(...styles: BlockObject[]): boolean {
    for (let i = 0; i < this.styleCorrelations.length; i++) {
      let c = this.styleCorrelations[i];
      if (styles.every(s => c.has(s))) {
        return true;
      }
    }
    return false;
  }

  isDynamic(style: BlockObject): boolean {
    return this.dynamicStyles.has(style);
  }

  wasFound(style: BlockObject): boolean {
    return this.stylesFound.has(style);
  }

  /**
   * Generates a [[SerializedTemplateAnalysis]] for this analysis.
   * @param pathsRelativeTo A path against which all the absolute paths in this analysis should be relativized.
   */
  serialize(): SerializedTemplateAnalysis {
    let blockRefs = {};
    let styles: string[] =  [];
    let dynamicStyles: number[] = [];
    Object.keys(this.blocks).forEach((localname) => {
      blockRefs[localname] = this.blocks[localname].source;
    });
    this.stylesFound.forEach((s) => {
      styles.push(this.serializedName(s));
    });
    styles.sort();

    this.dynamicStyles.forEach((dynamicStyle) => {
      dynamicStyles.push(styles.indexOf(this.serializedName(dynamicStyle)));
    });

    let correlations: number[][] = [];
    this.styleCorrelations.forEach((correlation) => {
      if (correlation.size > 1) {
        let cc: number[] = [];
        correlation.forEach((c) => {
          cc.push(styles.indexOf(this.serializedName(c)));
        });
        cc.sort();
        correlations.push(cc);
      }
    });
    return {
      template: this.template.serialize(),
      blocks: blockRefs,
      stylesFound: styles,
      dynamicStyles: dynamicStyles,
      styleCorrelations: correlations
    };
  }
}