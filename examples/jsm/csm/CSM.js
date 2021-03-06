/**
 * @author vHawk / https://github.com/vHawk/
 */

import {
	Vector2,
	Vector3,
	DirectionalLight,
	MathUtils,
	ShaderChunk,
	LineBasicMaterial,
	Object3D,
	BufferGeometry,
	BufferAttribute,
	Line,
	Matrix4,
	Box3
} from '../../../build/three.module.js';
import Frustum from './Frustum.js';
import Shader from './Shader.js';

const _cameraToLightMatrix = new Matrix4();
const _lightSpaceFrustum = new Frustum();
const _frustum = new Frustum();
const _center = new Vector3();
const _size = new Vector3();
const _bbox = new Box3();
const _uniformArray = [];
const _logArray = [];

export default class CSM {

	constructor( data ) {

		data = data || {};

		this.camera = data.camera;
		this.parent = data.parent;
		this.cascades = data.cascades || 3;
		this.maxFar = data.maxFar || 100000;
		this.mode = data.mode || 'practical';
		this.shadowMapSize = data.shadowMapSize || 2048;
		this.shadowBias = data.shadowBias || 0.000001;
		this.lightDirection = data.lightDirection || new Vector3( 1, - 1, 1 ).normalize();
		this.lightIntensity = data.lightIntensity || 1;
		this.lightNear = data.lightNear || 1;
		this.lightFar = data.lightFar || 2000;
		this.lightMargin = data.lightMargin || 200;
		this.customSplitsCallback = data.customSplitsCallback;
		this.fade = false;
		this.mainFrustum = new Frustum();
		this.frustums = [];
		this.breaks = [];

		this.lights = [];
		this.shaders = new Map();
		this.createLights();

		this.getBreaks();
		this.initCascades();

		this.injectInclude();

	}

	createLights() {

		for ( let i = 0; i < this.cascades; i ++ ) {

			const light = new DirectionalLight( 0xffffff, this.lightIntensity );
			light.castShadow = true;
			light.shadow.mapSize.width = this.shadowMapSize;
			light.shadow.mapSize.height = this.shadowMapSize;

			light.shadow.camera.near = this.lightNear;
			light.shadow.camera.far = this.lightFar;
			light.shadow.bias = this.shadowBias;

			this.parent.add( light );
			this.parent.add( light.target );
			this.lights.push( light );

		}

	}

	initCascades() {

		const camera = this.camera;
		camera.updateProjectionMatrix();
		this.mainFrustum.setFromProjectionMatrix( camera.projectionMatrix, this.maxFar );
		this.mainFrustum.split( this.breaks, this.frustums );

	}

	getBreaks() {

		const camera = this.camera;
		const far = Math.min( camera.far, this.maxFar );
		this.breaks.length = 0;

		switch ( this.mode ) {

			case 'uniform':
				uniformSplit( this.cascades, camera.near, far, this.breaks );
				break;
			case 'logarithmic':
				logarithmicSplit( this.cascades, camera.near, far, this.breaks );
				break;
			case 'practical':
				practicalSplit( this.cascades, camera.near, far, 0.5, this.breaks );
				break;
			case 'custom':
				if ( this.customSplitsCallback === undefined ) console.error( 'CSM: Custom split scheme callback not defined.' );
				this.customSplitsCallback( this.cascades, camera.near, far, this.breaks );
				break;

		}

		function uniformSplit( amount, near, far, target ) {

			for ( let i = 1; i < amount; i ++ ) {

				target.push( ( near + ( far - near ) * i / amount ) / far );

			}

			target.push( 1 );

		}

		function logarithmicSplit( amount, near, far, target ) {

			for ( let i = 1; i < amount; i ++ ) {

				target.push( ( near * ( far / near ) ** ( i / amount ) ) / far );

			}

			target.push( 1 );

		}

		function practicalSplit( amount, near, far, lambda, target ) {

			_uniformArray.length = 0;
			_logArray.length = 0;
			logarithmicSplit( amount, near, far, _logArray );
			uniformSplit( amount, near, far, _uniformArray );

			for ( let i = 1; i < amount; i ++ ) {

				target.push( MathUtils.lerp( _uniformArray[ i - 1 ], _logArray[ i - 1 ], lambda ) );

			}

			target.push( 1 );

		}

	}

	update( cameraMatrix ) {

		const frustums = this.frustums;
		for ( let i = 0; i < frustums.length; i ++ ) {

			const light = this.lights[ i ];
			light.shadow.camera.updateMatrixWorld( true );
			_cameraToLightMatrix.multiplyMatrices( light.shadow.camera.matrixWorldInverse, cameraMatrix );
			frustums[ i ].toSpace( _cameraToLightMatrix, _lightSpaceFrustum );

			_bbox.makeEmpty();
			for ( let j = 0; j < 4; j ++ ) {

				_bbox.expandByPoint( _lightSpaceFrustum.vertices.near[ j ] );
				_bbox.expandByPoint( _lightSpaceFrustum.vertices.far[ j ] );

			}

			_bbox.getSize( _size );
			_bbox.getCenter( _center );
			_center.z = _bbox.max.z + this.lightMargin;
			_center.applyMatrix4( light.shadow.camera.matrixWorld );

			let squaredBBWidth = Math.max( _size.x, _size.y );
			if ( this.fade ) {

				// expand the shadow extents by the fade margin if fade is enabled.
				const camera = this.camera;
				const far = Math.max( camera.far, this.maxFar );
				const linearDepth = frustums[ i ].vertices.far[ 0 ].z / ( far - camera.near );
				const margin = 0.25 * Math.pow( linearDepth, 2.0 ) * ( far - camera.near );

				squaredBBWidth += margin;

			}

			light.shadow.camera.left = - squaredBBWidth / 2;
			light.shadow.camera.right = squaredBBWidth / 2;
			light.shadow.camera.top = squaredBBWidth / 2;
			light.shadow.camera.bottom = - squaredBBWidth / 2;

			light.position.copy( _center );
			light.target.position.copy( _center );

			light.target.position.x += this.lightDirection.x;
			light.target.position.y += this.lightDirection.y;
			light.target.position.z += this.lightDirection.z;

			light.shadow.camera.updateProjectionMatrix();
			light.shadow.camera.updateMatrixWorld();

		}

	}

	injectInclude() {

		ShaderChunk.lights_fragment_begin = Shader.lights_fragment_begin;
		ShaderChunk.lights_pars_begin = Shader.lights_pars_begin;

	}

	setupMaterial( material ) {

		material.defines = material.defines || {};
		material.defines.USE_CSM = 1;
		material.defines.CSM_CASCADES = this.cascades;

		if ( this.fade ) {

			material.defines.CSM_FADE = '';

		}

		const breaksVec2 = [];
		const self = this;
		const shaders = this.shaders;

		material.onBeforeCompile = function ( shader ) {

			const far = Math.min( self.camera.far, self.maxFar );
			self.getExtendedBreaks( breaksVec2 );

			shader.uniforms.CSM_cascades = { value: breaksVec2 };
			shader.uniforms.cameraNear = { value: self.camera.near };
			shader.uniforms.shadowFar = { value: far };

			shaders.set( material, shader );

		};
		shaders.set( material, null );

	}

	updateUniforms() {

		const far = Math.min( this.camera.far, this.maxFar );
		const shaders = this.shaders;

		shaders.forEach( function ( shader, material ) {

			if ( shader !== null ) {

				const uniforms = shader.uniforms;
				this.getExtendedBreaks( uniforms.CSM_cascades.value );
				uniforms.cameraNear.value = this.camera.near;
				uniforms.shadowFar.value = far;

			}

			if ( ! this.fade && 'CSM_FADE' in material.defines ) {

				delete material.defines.CSM_FADE;
				material.needsUpdate = true;

			} else if ( this.fade && ! ( 'CSM_FADE' in material.defines ) ) {

				material.defines.CSM_FADE = '';
				material.needsUpdate = true;

			}

		}, this );

	}

	getExtendedBreaks( target ) {

		while ( target.length < this.breaks.length ) {

			target.push( new Vector2() );

		}
		target.length = this.breaks.length;

		for ( let i = 0; i < this.cascades; i ++ ) {

			let amount = this.breaks[ i ];
			let prev = this.breaks[ i - 1 ] || 0;
			target[ i ].x = prev;
			target[ i ].y = amount;

		}

	}

	updateFrustums() {

		this.getBreaks();
		this.initCascades();
		this.updateUniforms();

	}

	helper( cameraMatrix ) {

		let geometry, vertices;
		const material = new LineBasicMaterial( { color: 0xffffff } );
		const object = new Object3D();

		for ( let i = 0; i < this.frustums.length; i ++ ) {

			this.frustums[ i ].toSpace( cameraMatrix, _frustum );

			geometry = new BufferGeometry();
			vertices = [];


			for ( let i = 0; i < 5; i ++ ) {

				const point = _frustum.vertices.near[ i === 4 ? 0 : i ];
				vertices.push( point.x, point.y, point.z );

			}

			geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( vertices ), 3 ) );

			object.add( new Line( geometry, material ) );

			geometry = new BufferGeometry();
			vertices = [];

			for ( let i = 0; i < 5; i ++ ) {

				const point = _frustum.vertices.far[ i === 4 ? 0 : i ];
				vertices.push( point.x, point.y, point.z );

			}

			geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( vertices ), 3 ) );

			object.add( new Line( geometry, material ) );

			for ( let i = 0; i < 4; i ++ ) {

				geometry = new BufferGeometry();
				vertices = [];

				const near = _frustum.vertices.near[ i ];
				const far = _frustum.vertices.far[ i ];

				vertices.push( near.x, near.y, near.z );
				vertices.push( far.x, far.y, far.z );

				geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( vertices ), 3 ) );

				object.add( new Line( geometry, material ) );

			}

		}

		return object;

	}

	remove() {

		for ( let i = 0; i < this.lights.length; i ++ ) {

			this.parent.remove( this.lights[ i ] );

		}

	}

	dispose() {

		const shaders = this.shaders;
		shaders.forEach( function ( shader, material ) {

			delete material.onBeforeCompile;
			delete material.defines.USE_CSM;
			delete material.defines.CSM_CASCADES;
			delete material.defines.CSM_FADE;

			delete shader.uniforms.CSM_cascades;
			delete shader.uniforms.cameraNear;
			delete shader.uniforms.shadowFar;

			material.needsUpdate = true;

		} );
		shaders.clear();

	}

}
